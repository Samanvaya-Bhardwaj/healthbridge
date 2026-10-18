"""General health information for the assistant (ADR-0040). Internal: service + scope tokens.

The backend sends the person's message from a doctor-search turn. Code picks the library
article whose words the message uses; with none, nothing else happens (no model call). With
one, the agent writes a short cited summary, and the article's lists come back as written.
The message is never stored: the run keeps the backend's keyed digest only.
"""

import asyncio
import logging
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, ConfigDict, Field

from app.agents.health_agent import build_health_agent
from app.agents.prompts import HEALTH_PROMPT_VERSION
from app.core.digest import InputDigest
from app.core.errors import ProblemError
from app.core.logging import log_event, request_id_ctx
from app.core.scope import ScopeDep
from app.core.security import require_service_token
from app.health.library import match, sources
from app.repositories import ai_store

logger = logging.getLogger("healthbridge.ai.health_info")
router = APIRouter(
    prefix="/v1/health-info", tags=["health-info"], dependencies=[Depends(require_service_token)]
)

Uuid = Annotated[str, Field(min_length=36, max_length=36)]


class HealthInfoRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    patientId: Uuid
    message: Annotated[str, Field(min_length=1, max_length=500)]
    # The backend's keyed digest of the message (this service never hashes free text).
    inputDigest: InputDigest
    # A slow local model must not hold up the reply: past this, the lists come back alone.
    summaryTimeoutSeconds: Annotated[float, Field(ge=1, le=300)] = 60


@router.post("/answer")
async def answer(body: HealthInfoRequest, scope: ScopeDep, request: Request) -> dict:
    if scope.purpose != "care_assistant":
        raise ProblemError(403, "out_of_scope", "Out of scope", "Wrong purpose for this call.")
    scope.require_patient(body.patientId)
    article = match(body.message, request.app.state.health_library)
    if article is None:
        return {"matched": False}
    run_id, started = ai_store.new_id(), datetime.now(UTC)
    passages = sources(article)
    agent, totals = build_health_agent(request.app.state.llm)
    try:
        state = await asyncio.wait_for(
            agent.ainvoke(
                {
                    "run_id": run_id,
                    "request_id": request_id_ctx.get(),
                    "question": body.message,
                    "sources": passages,
                },
                config={"configurable": {"thread_id": run_id}},
            ),
            timeout=body.summaryTimeoutSeconds,
        )
    except TimeoutError:
        state = {"status": "timeout", "sentences": [], "removed": 0, "error_kind": "timeout"}
    async with request.app.state.db.patient_scope(scope.patient_id) as conn:
        await ai_store.insert_run(
            conn,
            run_id=run_id,
            workflow="health_info",
            agent="health_info_agent",
            patient_id=scope.patient_id,
            status="error" if state["status"] in ("failed", "timeout") else "ok",
            totals=totals,
            started_at=started,
            prompt_version=HEALTH_PROMPT_VERSION,
            input_hash=body.inputDigest.value,
            input_digest_key_id=body.inputDigest.keyId,
            validation="citations_valid"
            if state["status"] == "answered"
            else "insufficient_evidence",
            injection_flags=[],
            error_kind=state.get("error_kind"),
            request_id=request_id_ctx.get(),
        )
    # Metadata only: not the message, the article or the summary (the topic is health data).
    log_event(
        logger,
        logging.INFO,
        "health information",
        runId=run_id,
        status=state["status"],
        sentences=len(state["sentences"]),
        removed=state["removed"],
    )
    sections = {s.label: s.text.split(": ", 1)[0].rsplit(", ", 1)[-1] for s in passages}
    return {
        "matched": True,
        "runId": run_id,
        "status": state["status"],
        "article": article.view(),
        "summary": [
            {
                "text": s["text"],
                "citations": [
                    {"label": c["label"], "section": sections[c["label"]]} for c in s["citations"]
                ],
            }
            for s in state["sentences"]
        ],
    }
