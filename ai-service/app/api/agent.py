"""Care assistant step (M13.1, ADR-0029). Internal: service + patient scope tokens.

The backend calls this once per step of an assistant turn and executes any tool the
step asks for. Nothing is stored here except an `ai.ai_runs` record per message
(metadata and a hash of the message; never the text).
"""

import hashlib
import logging
import time
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, ConfigDict, Field

from app.agents.care_assistant import (
    MAX_TOOL_ROUNDS,
    StepContext,
    ToolName,
    ToolResult,
    build_care_assistant,
    parse_state,
)
from app.agents.care_prompts import CARE_PROMPT_VERSION
from app.core.errors import ProblemError
from app.core.logging import log_event, request_id_ctx
from app.core.metrics import AGENT_STEPS
from app.core.scope import ScopeDep
from app.core.security import require_service_token
from app.documents.grounding import detect_injection
from app.repositories import ai_store

logger = logging.getLogger("healthbridge.ai.agent")
router = APIRouter(
    prefix="/v1/agent", tags=["agent"], dependencies=[Depends(require_service_token)]
)

Uuid = Annotated[str, Field(min_length=36, max_length=36)]


class StepRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    patientId: Uuid
    sessionId: Uuid
    message: Annotated[str, Field(min_length=1, max_length=500)] | None = None
    state: dict[str, Any] = Field(default_factory=dict)
    toolResult: ToolResult | None = None
    toolsThisTurn: Annotated[list[ToolName], Field(max_length=MAX_TOOL_ROUNDS)] = []
    context: StepContext


@router.post("/step")
async def step(body: StepRequest, scope: ScopeDep, request: Request) -> dict:
    if scope.purpose != "care_assistant":
        raise ProblemError(403, "out_of_scope", "Out of scope", "Wrong purpose for this call.")
    scope.require_patient(body.patientId)
    if (body.message is None) == (body.toolResult is None):
        raise ProblemError(
            400, "invalid_step", "Invalid step", "Send either a message or a tool result."
        )
    started_wall, started = datetime.now(UTC), time.perf_counter()
    run_id = ai_store.new_id()
    agent, totals = build_care_assistant(request.app.state.llm)
    result = await agent.ainvoke(
        {
            "run_id": run_id,
            "request_id": request_id_ctx.get(),
            "state": parse_state(body.state),
            "context": body.context,
            "message": body.message,
            "tool_result": body.toolResult,
            "tools_this_turn": list(body.toolsThisTurn),
        }
    )
    action = result.get("action") or {"type": "respond"}
    reply = result.get("reply")
    error_kind = result.get("error_kind")
    status = "error" if error_kind else "ok"
    AGENT_STEPS.labels(
        "care_assistant",
        action.get("tool", action["type"]),
        "fallback" if reply is not None and reply.kind == "fallback" else "ok",
    ).inc()

    # One AI execution record per message (tool-result steps make no model call).
    if body.message is not None:
        async with request.app.state.db.patient_scope(scope.patient_id) as conn:
            await ai_store.insert_run(
                conn,
                run_id=run_id,
                workflow="care_assistant",
                agent="care_assistant",
                patient_id=scope.patient_id,
                status=status,
                totals=totals,
                started_at=started_wall,
                prompt_version=CARE_PROMPT_VERSION,
                input_hash=hashlib.sha256(body.message.encode()).hexdigest(),
                validation="rejected" if error_kind else "schema_valid",
                injection_flags=detect_injection(body.message),
                error_kind=error_kind,
                request_id=request_id_ctx.get(),
            )
    log_event(
        logger,
        logging.INFO,
        "agent step",
        event="agent_step",
        runId=run_id,
        workflow="care_assistant",
        action=action["type"],
        tool=action.get("tool"),
        replyKind=reply.kind if reply is not None else None,
        status=status,
        errorKind=error_kind,
        llmCalls=totals.calls,
        latencyMs=round((time.perf_counter() - started) * 1000),
    )
    return {
        "state": result["state"].model_dump(),
        "action": action,
        "reply": reply.model_dump(exclude_none=True) if reply is not None else None,
        "run": {"runId": run_id, "status": status, "llmCalls": totals.calls},
    }
