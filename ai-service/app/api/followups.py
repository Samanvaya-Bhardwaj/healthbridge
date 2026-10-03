"""Bounded follow-up agent (ADR-0026). Internal: service + patient scope tokens.

Summarises one follow-up check-in for the treating doctor from backend-provided facts.
The result is cited and validated, stored in `ai.follow_up_summaries`, shown only to the
doctor and labelled as AI-generated. It never contacts the patient and never escalates.
"""

import hashlib
import json
import logging
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from app.agents.assist_agent import build_followup_agent
from app.agents.prompts import FOLLOWUP_PROMPT_VERSION
from app.core.errors import ProblemError
from app.core.logging import log_event, request_id_ctx
from app.core.scope import ScopeDep
from app.core.security import require_service_token
from app.rag.retrieval import Source
from app.repositories import ai_store

logger = logging.getLogger("healthbridge.ai.followups")
router = APIRouter(
    prefix="/v1/followups", tags=["followups"], dependencies=[Depends(require_service_token)]
)

Uuid = Annotated[str, Field(min_length=36, max_length=36)]


class CheckInFact(BaseModel):
    id: Uuid
    text: Annotated[str, Field(min_length=1, max_length=1000)]


class SummaryRequest(BaseModel):
    patientId: Uuid
    followUpId: Uuid
    doctorUserId: Uuid
    facts: Annotated[list[CheckInFact], Field(max_length=12)] = []


@router.post("/summary")
async def summary(body: SummaryRequest, scope: ScopeDep, request: Request) -> dict:
    if scope.purpose != "follow_up_summary":
        raise ProblemError(403, "out_of_scope", "Out of scope", "Wrong purpose for this call.")
    scope.require_patient(body.patientId)
    db, llm = request.app.state.db, request.app.state.llm
    run_id, started = ai_store.new_id(), datetime.now(UTC)
    sources = [
        Source(f"F{i + 1}", "follow_up_response", f.id, None, f.text)
        for i, f in enumerate(body.facts)
    ]
    agent, totals = build_followup_agent(llm)
    state = await agent.ainvoke(
        {"run_id": run_id, "request_id": request_id_ctx.get(), "sources": sources},
        config={"configurable": {"thread_id": run_id}},
    )
    # Only a hash of the input is kept with the run; the facts are not logged.
    input_hash = hashlib.sha256(
        json.dumps([body.followUpId, [f.text for f in body.facts]]).encode()
    ).hexdigest()
    summary_id = ai_store.new_id()
    async with db.patient_scope(scope.patient_id) as conn:
        await ai_store.insert_run(
            conn,
            run_id=run_id,
            workflow="follow_up_summary",
            agent="follow_up_agent",
            patient_id=scope.patient_id,
            status="error" if state["status"] == "failed" else "ok",
            totals=totals,
            started_at=started,
            prompt_version=FOLLOWUP_PROMPT_VERSION,
            input_hash=input_hash,
            validation="citations_valid" if state["status"] == "ready" else "insufficient_evidence",
            injection_flags=[],
            error_kind=state.get("error_kind"),
            request_id=request_id_ctx.get(),
        )
        cited = {c["id"] for s in state["sentences"] for c in s["citations"]}
        for source_id in sorted(cited):
            await conn.execute(
                """INSERT INTO ai.ai_sources (id, run_id, patient_id, source_type, source_id)
                   VALUES (%s, %s, %s, %s, %s)""",
                (ai_store.new_id(), run_id, scope.patient_id, "follow_up_response", source_id),
            )
        await conn.execute(
            """INSERT INTO ai.follow_up_summaries (id, follow_up_id, patient_id, doctor_user_id,
                 run_id, status, sentences, removed_sentence_count, prompt_version)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            (
                summary_id,
                body.followUpId,
                scope.patient_id,
                body.doctorUserId,
                run_id,
                "ready" if state["status"] == "ready" else "insufficient_information",
                json.dumps(state["sentences"]),
                state["removed"],
                FOLLOWUP_PROMPT_VERSION,
            ),
        )
    log_event(
        logger,
        logging.INFO,
        "follow-up summary",
        runId=run_id,
        status=state["status"],
        sentences=len(state["sentences"]),
        removed=state["removed"],
        facts=len(sources),
    )
    return {
        "summaryId": summary_id,
        "runId": run_id,
        "status": state["status"],
        "sentences": state["sentences"],
        "removedSentenceCount": state["removed"],
    }
