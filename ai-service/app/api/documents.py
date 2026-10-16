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
from app.embeddings import to_pgvector
from app.llm.base import LLMError
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
    try:
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
    except LLMError as exc:
        # Retryable only (the agent stores every other failure). Nothing is recorded, so
        # the backend's job retry, or a dead-letter retry, analyses the document afresh.
        log_event(
            logger,
            logging.WARNING,
            "document analysis deferred",
            runId=run_id,
            errorKind=exc.kind.value,
        )
        raise ProblemError(
            503,
            "ai_unavailable",
            "AI temporarily unavailable",
            "Document analysis is deferred; retry later.",
        ) from exc

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
                embedding_model=embedder.model_id,
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


class ReembedRequest(BaseModel):
    patientId: str = Field(min_length=36, max_length=36)
    documentIds: list[str] = Field(min_length=1, max_length=500)


REEMBED_LIMIT = 400

# Chunks of the latest extraction of each document (what retrieval reads) that have no
# vector of the current model yet: neither their own nor one added here before.
_STALE_CHUNKS = """
  SELECT c.id::text, c.document_id::text, c.content
    FROM ai.document_chunks c
   WHERE c.document_id = ANY(%(docs)s::uuid[])
     AND c.extraction_id IN (
       SELECT DISTINCT ON (e.document_id) e.id FROM ai.document_extractions e
        WHERE e.document_id = ANY(%(docs)s::uuid[]) AND e.status <> 'failed'
        ORDER BY e.document_id, e.version DESC)
     AND c.embedding_model <> %(model)s
     AND NOT EXISTS (SELECT 1 FROM ai.chunk_vectors v
                      WHERE v.chunk_id = c.id AND v.model = %(model)s)
   ORDER BY c.document_id, c.chunk_index
   LIMIT %(limit)s
"""


@router.post("/reembed")
async def reembed(body: ReembedRequest, scope: ScopeDep, request: Request) -> dict:
    """Part 4: chunks embedded by another model get a vector of the current one.

    After switching embedding providers (e.g. to Ollama), vector ranking compares only
    within one model (ADR-0037). Chunks are append-only, so the new vector is added beside
    the chunk (`ai.chunk_vectors`); the text is not read again or copied. At most
    REEMBED_LIMIT chunks per call: `more` says whether to call again.
    """
    if scope.purpose != "document_analysis":
        raise ProblemError(403, "out_of_scope", "Out of scope", "Wrong purpose for this call.")
    scope.require_patient(body.patientId)
    for document_id in body.documentIds:
        scope.require_document(document_id)
    embedder = request.app.state.embedder
    model = embedder.model_id
    added = 0
    async with request.app.state.db.patient_scope(scope.patient_id) as conn:
        rows = await (
            await conn.execute(
                _STALE_CHUNKS,
                {"docs": body.documentIds, "model": model, "limit": REEMBED_LIMIT},
            )
        ).fetchall()
        for i in range(0, len(rows), 16):
            batch = rows[i : i + 16]
            vectors = await embedder.embed([r[2] for r in batch])
            for (chunk_id, _doc, _text), vector in zip(batch, vectors, strict=True):
                await conn.execute(
                    """INSERT INTO ai.chunk_vectors (chunk_id, patient_id, model, embedding)
                       VALUES (%s, %s, %s, %s::extensions.vector)
                       ON CONFLICT (chunk_id, model) DO NOTHING""",
                    (chunk_id, scope.patient_id, model, to_pgvector(vector)),
                )
                added += 1
    if added:
        log_event(logger, logging.INFO, "chunks re-embedded", updated=added, model=model)
    return {"model": model, "updated": added, "more": len(rows) == REEMBED_LIMIT}
