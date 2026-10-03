"""Record questions and doctor briefs (ADR-0024). Internal: service + patient scope tokens."""

import hashlib
import json
import logging
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from app.agents.assist_agent import build_answer_agent, build_brief_agent
from app.agents.prompts import ASSIST_PROMPT_VERSION
from app.core.errors import ProblemError
from app.core.logging import log_event, request_id_ctx
from app.core.scope import PatientScope, ScopeDep
from app.core.security import require_service_token
from app.rag.retrieval import Source, hybrid_search
from app.rag.validation import INSUFFICIENT
from app.repositories import ai_store

logger = logging.getLogger("healthbridge.ai.assist")
router = APIRouter(
    prefix="/v1/assist", tags=["assist"], dependencies=[Depends(require_service_token)]
)

Uuid = Annotated[str, Field(min_length=36, max_length=36)]


class Fact(BaseModel):
    id: Uuid
    text: Annotated[str, Field(min_length=1, max_length=300)]


class AnswerRequest(BaseModel):
    patientId: Uuid
    question: Annotated[str, Field(min_length=3, max_length=500)]
    documentIds: Annotated[list[Uuid], Field(max_length=200)] = []
    facts: Annotated[list[Fact], Field(max_length=60)] = []


class BriefRequest(BaseModel):
    patientId: Uuid
    appointmentId: Uuid
    doctorUserId: Uuid
    documentIds: Annotated[list[Uuid], Field(max_length=200)] = []
    facts: Annotated[list[Fact], Field(max_length=60)] = []


def _check(scope: PatientScope, purpose: str, patient_id: str, document_ids: list[str]) -> None:
    if scope.purpose != purpose:
        raise ProblemError(403, "out_of_scope", "Out of scope", "Wrong purpose for this call.")
    scope.require_patient(patient_id)
    for doc in document_ids:
        scope.require_document(doc)


def _facts(facts: list[Fact]) -> list[Source]:
    return [Source(f"F{i + 1}", "lab_result", f.id, None, f.text) for i, f in enumerate(facts)]


async def _record(
    conn: Any,
    *,
    run_id: str,
    workflow: str,
    agent: str,
    scope: PatientScope,
    totals,
    started,
    status: str,
    validation: str,
    input_hash: str,
    cited: list[dict[str, Any]],
    error_kind: str | None,
) -> None:
    await ai_store.insert_run(
        conn,
        run_id=run_id,
        workflow=workflow,
        agent=agent,
        patient_id=scope.patient_id,
        status=status,
        totals=totals,
        started_at=started,
        prompt_version=ASSIST_PROMPT_VERSION,
        input_hash=input_hash,
        validation=validation,
        injection_flags=[],
        error_kind=error_kind,
        request_id=request_id_ctx.get(),
    )
    seen: set[tuple[str, str]] = set()
    for c in cited:
        key = ("document_chunk" if c["type"] == "document_chunk" else "lab_result", c["id"])
        if key in seen:
            continue
        seen.add(key)
        await conn.execute(
            """INSERT INTO ai.ai_sources (id, run_id, patient_id, source_type, source_id)
               VALUES (%s, %s, %s, %s, %s)""",
            (ai_store.new_id(), run_id, scope.patient_id, key[0], key[1]),
        )


@router.post("/answer")
async def answer(body: AnswerRequest, scope: ScopeDep, request: Request) -> dict:
    _check(scope, "record_question", body.patientId, body.documentIds)
    db, llm, embedder = request.app.state.db, request.app.state.llm, request.app.state.embedder
    run_id, started = ai_store.new_id(), datetime.now(UTC)
    async with db.patient_scope(scope.patient_id) as conn:
        chunks = await hybrid_search(conn, embedder, body.question, body.documentIds)
    candidates = [*chunks, *_facts(body.facts)]
    agent, totals = build_answer_agent(llm)
    state = await agent.ainvoke(
        {
            "run_id": run_id,
            "request_id": request_id_ctx.get(),
            "question": body.question,
            "candidates": candidates,
        },
        config={"configurable": {"thread_id": run_id}},
    )
    cited = [c for s in state["sentences"] for c in s["citations"]]
    # Only a hash of the question is kept: the question text is never stored or logged.
    input_hash = hashlib.sha256(body.question.encode()).hexdigest()
    async with db.patient_scope(scope.patient_id) as conn:
        await _record(
            conn,
            run_id=run_id,
            workflow="record_question",
            agent="rag_agent",
            scope=scope,
            totals=totals,
            started=started,
            status="error" if state["status"] == "failed" else "ok",
            validation="citations_valid"
            if state["status"] == "answered"
            else "insufficient_evidence",
            input_hash=input_hash,
            cited=cited,
            error_kind=state.get("error_kind"),
        )
    log_event(
        logger,
        logging.INFO,
        "record question",
        runId=run_id,
        status=state["status"],
        sentences=len(state["sentences"]),
        removed=state["removed"],
        sources=len(candidates),
    )
    return {
        "runId": run_id,
        "status": state["status"],
        "answer": " ".join(s["text"] for s in state["sentences"])
        if state["sentences"]
        else INSUFFICIENT,
        "sentences": state["sentences"],
        "removedSentenceCount": state["removed"],
    }


async def _first_chunks(conn: Any, document_ids: list[str]) -> list[Source]:
    """First chunk of the latest extraction of each authorised document."""
    if not document_ids:
        return []
    cur = await conn.execute(
        """SELECT DISTINCT ON (c.document_id) c.id::text, c.document_id::text, c.content
             FROM ai.document_chunks c
             JOIN ai.document_extractions e ON e.id = c.extraction_id
            WHERE c.document_id = ANY(%s::uuid[]) AND e.status <> 'failed'
            ORDER BY c.document_id, e.version DESC, c.chunk_index ASC""",
        (document_ids,),
    )
    rows = await cur.fetchall()
    return [
        Source(f"S{i + 1}", "document_chunk", r[0], r[1], r[2]) for i, r in enumerate(rows[:10])
    ]


@router.post("/brief")
async def brief(body: BriefRequest, scope: ScopeDep, request: Request) -> dict:
    _check(scope, "doctor_brief", body.patientId, body.documentIds)
    db, llm = request.app.state.db, request.app.state.llm
    run_id, started = ai_store.new_id(), datetime.now(UTC)
    async with db.patient_scope(scope.patient_id) as conn:
        chunks = await _first_chunks(conn, body.documentIds)
    sources = [*_facts(body.facts), *chunks]
    agent, totals = build_brief_agent(llm)
    state = await agent.ainvoke(
        {"run_id": run_id, "request_id": request_id_ctx.get(), "sources": sources},
        config={"configurable": {"thread_id": run_id}},
    )
    cited = [c for sec in state["sections"] for s in sec["sentences"] for c in s["citations"]]
    brief_id = ai_store.new_id()
    input_hash = hashlib.sha256(
        json.dumps([body.appointmentId, body.documentIds, [f.id for f in body.facts]]).encode()
    ).hexdigest()
    async with db.patient_scope(scope.patient_id) as conn:
        await _record(
            conn,
            run_id=run_id,
            workflow="doctor_brief",
            agent="pre_consultation_agent",
            scope=scope,
            totals=totals,
            started=started,
            status="error" if state["status"] == "failed" else "ok",
            validation="citations_valid" if state["status"] == "ready" else "insufficient_evidence",
            input_hash=input_hash,
            cited=cited,
            error_kind=state.get("error_kind"),
        )
        await conn.execute(
            """INSERT INTO ai.doctor_briefs (id, patient_id, appointment_id, doctor_user_id, run_id,
                 status, sections, source_count, removed_sentence_count, prompt_version)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            (
                brief_id,
                scope.patient_id,
                body.appointmentId,
                body.doctorUserId,
                run_id,
                state["status"],
                json.dumps(state["sections"]),
                len(sources),
                state["removed"],
                ASSIST_PROMPT_VERSION,
            ),
        )
    log_event(
        logger,
        logging.INFO,
        "doctor brief",
        runId=run_id,
        status=state["status"],
        sections=len(state["sections"]),
        removed=state["removed"],
        sources=len(sources),
    )
    return {
        "briefId": brief_id,
        "runId": run_id,
        "status": state["status"],
        "sections": state["sections"],
        "message": None if state["sections"] else INSUFFICIENT,
        "removedSentenceCount": state["removed"],
    }
