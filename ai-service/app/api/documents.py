"""Document analysis endpoint (ADR-0022). Internal: service token + patient scope token."""

import base64
import binascii
import hashlib
import logging
from datetime import UTC, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from app.agents.document_agent import build_document_agent
from app.agents.prompts import DOCUMENT_PROMPT_VERSION
from app.core.errors import ProblemError
from app.core.logging import log_event, request_id_ctx
from app.core.scope import ScopeDep
from app.core.security import require_service_token
from app.documents.grounding import chunk_text
from app.repositories import ai_store

logger = logging.getLogger("healthbridge.ai.documents")
router = APIRouter(
    prefix="/v1/documents", tags=["documents"], dependencies=[Depends(require_service_token)]
)

MAX_DOCUMENT_BYTES = 25 * 1024 * 1024
DocumentType = Literal["lab_report", "prescription", "imaging", "discharge_summary", "other"]


class AnalyzeRequest(BaseModel):
    patientId: str = Field(min_length=36, max_length=36)
    documentId: str = Field(min_length=36, max_length=36)
    documentType: DocumentType
    contentType: Literal["application/pdf", "image/png", "image/jpeg"]
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    contentBase64: Annotated[str, Field(max_length=MAX_DOCUMENT_BYTES * 4 // 3 + 16)]


def _view(row: dict, *, reused: bool) -> dict:
    return {
        "extractionId": str(row["id"]),
        "version": row["version"],
        "status": row["status"],
        "textSource": row["text_source"],
        "classification": row["classification"],
        "fields": row["fields"],
        "droppedFieldCount": row["dropped_field_count"],
        "injectionFlags": list(row["injection_flags"]),
        "runId": str(row["run_id"]),
        "reused": reused,
    }


@router.post("/analyze")
async def analyze(body: AnalyzeRequest, scope: ScopeDep, request: Request) -> dict:
    if scope.purpose != "document_analysis":
        raise ProblemError(403, "out_of_scope", "Out of scope", "Wrong purpose for this call.")
    scope.require_patient(body.patientId)
    scope.require_document(body.documentId)
    try:
        content = base64.b64decode(body.contentBase64, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ProblemError(
            400, "invalid_content", "Invalid content", "Content is not base64."
        ) from exc
    if hashlib.sha256(content).hexdigest() != body.sha256:
        raise ProblemError(400, "checksum_mismatch", "Checksum mismatch", "Content does not match.")

    db = request.app.state.db
    llm = request.app.state.llm
    embedder = request.app.state.embedder
    input_hash = hashlib.sha256(f"{body.sha256}:{body.documentType}".encode()).hexdigest()

    # Idempotent: the same document content under the same prompt version is not re-run.
    async with db.patient_scope(scope.patient_id) as conn:
        existing = await ai_store.find_extraction(
            conn, body.documentId, input_hash, DOCUMENT_PROMPT_VERSION
        )
    if existing:
        return _view(existing, reused=True)

    run_id = ai_store.new_id()
    started = datetime.now(UTC)
    agent, totals = build_document_agent(llm)
    state = await agent.ainvoke(
        {
            "run_id": run_id,
            "request_id": request_id_ctx.get(),
            "content": content,
            "content_type": body.contentType,
            "declared_type": body.documentType,
        },
        config={"configurable": {"thread_id": run_id}},
    )

    status = state["status"]
    run_status = (
        "error"
        if status == "failed" and state.get("error_kind") != "refused"
        else ("refused" if state.get("error_kind") == "refused" else "ok")
    )
    chunks = chunk_text(state["text"]) if state["text"] else []
    vectors = await embedder.embed(chunks) if chunks else []

    extraction_id = ai_store.new_id()
    async with db.patient_scope(scope.patient_id) as conn:
        await ai_store.insert_run(
            conn,
            run_id=run_id,
            workflow="document_analysis",
            agent="document_agent",
            patient_id=scope.patient_id,
            status=run_status,
            totals=totals,
            started_at=started,
            prompt_version=DOCUMENT_PROMPT_VERSION,
            input_hash=input_hash,
            validation=state.get("validation"),
            injection_flags=state["injection_flags"],
            error_kind=state.get("error_kind"),
            request_id=request_id_ctx.get(),
        )
        version = await ai_store.insert_extraction(
            conn,
            extraction_id=extraction_id,
            patient_id=scope.patient_id,
            document_id=body.documentId,
            document_type=body.documentType,
            run_id=run_id,
            input_sha256=input_hash,
            prompt_version=DOCUMENT_PROMPT_VERSION,
            status=status,
            text_source=state["text_source"],
            classification=state["classification"],
            fields=state["fields"],
            dropped=state["dropped"],
            injection_flags=state["injection_flags"],
        )
        if status != "failed" and chunks:
            await ai_store.insert_chunks(
                conn,
                patient_id=scope.patient_id,
                document_id=body.documentId,
                document_type=body.documentType,
                extraction_id=extraction_id,
                chunks=chunks,
                vectors=vectors,
            )

    log_event(
        logger,
        logging.INFO,
        "document analysed",
        runId=run_id,
        status=status,
        textSource=state["text_source"],
        fieldCount=len(state["fields"]),
        droppedFieldCount=state["dropped"],
        injectionFlags=state["injection_flags"],
        chunkCount=len(chunks),
        llmCalls=totals.calls,
    )
    return _view(
        {
            "id": extraction_id,
            "version": version,
            "status": status,
            "text_source": state["text_source"],
            "classification": state["classification"],
            "fields": state["fields"],
            "dropped_field_count": state["dropped"],
            "injection_flags": state["injection_flags"],
            "run_id": run_id,
        },
        reused=False,
    )
