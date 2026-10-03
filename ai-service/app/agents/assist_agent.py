"""Retrieval-grounded assistants (ADR-0011, ADR-0024): fixed LangGraph workflows, no tools.

Record question:  retrieve ─► rerank ─► decide ─► generate ─► validate
                                          └─(no relevant source)─► insufficient
Doctor brief:     gather ─► generate ─► validate

Sources are the authorised document chunks (patient- and document-scoped retrieval) and
backend-provided verified facts. Generation cites source labels; validation keeps only
cited, number-consistent, non-diagnostic sentences. Nothing survives → the fixed
insufficient-information answer.
"""

from typing import Any, TypedDict

from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, StateGraph

from app.agents.prompts import (
    ANSWER_SCHEMA,
    ANSWER_SYSTEM,
    BRIEF_SCHEMA,
    BRIEF_SYSTEM,
    sources_message,
)
from app.llm.base import LLMError, LLMMessage, LLMProvider, LLMRequest, ModelTier, StopReason
from app.rag.retrieval import Source, overlap, rerank
from app.rag.validation import validate_sentences
from app.repositories.ai_store import RunTotals


class AssistState(TypedDict, total=False):
    run_id: str
    request_id: str | None
    question: str
    candidates: list[Source]
    sources: list[Source]
    raw: dict[str, Any]
    sentences: list[dict[str, Any]]
    sections: list[dict[str, Any]]
    removed: int
    status: str
    error_kind: str | None


def _call(
    llm: LLMProvider,
    totals: RunTotals,
    state: AssistState,
    workflow: str,
    system: str,
    schema: dict,
    content: str,
):
    async def run():
        response = await llm.generate(
            LLMRequest(
                workflow=workflow,
                system=system,
                messages=[LLMMessage(role="user", content=content)],
                json_schema=schema,
                tier=ModelTier.DEFAULT,
                max_tokens=2048,
                run_id=state["run_id"],
                request_id=state.get("request_id"),
            )
        )
        totals.add(response)
        return response

    return run()


def build_answer_agent(llm: LLMProvider):
    totals = RunTotals()

    async def node_rerank(state: AssistState) -> AssistState:
        return {"sources": rerank(state["question"], state["candidates"], limit=8)}

    def decide(state: AssistState) -> str:
        relevant = any(overlap(state["question"], s) > 0 for s in state["sources"])
        return "generate" if relevant else "insufficient"

    async def node_insufficient(_state: AssistState) -> AssistState:
        return {"sentences": [], "removed": 0, "status": "insufficient_information"}

    async def node_generate(state: AssistState) -> AssistState:
        try:
            res = await _call(
                llm,
                totals,
                state,
                "record_question",
                ANSWER_SYSTEM,
                ANSWER_SCHEMA,
                sources_message(state["sources"], state["question"]),
            )
        except LLMError as exc:
            return {"raw": {}, "error_kind": exc.kind.value}
        if res.stop_reason is not StopReason.END or not isinstance(res.json_output, dict):
            return {"raw": {}, "error_kind": "refused"}
        return {"raw": res.json_output}

    async def node_validate(state: AssistState) -> AssistState:
        kept, removed = validate_sentences(
            state.get("raw", {}).get("sentences") or [], state["sources"]
        )
        if state.get("error_kind") and not kept:
            return {"sentences": [], "removed": removed, "status": "failed"}
        return {
            "sentences": kept,
            "removed": removed,
            "status": "answered" if kept else "insufficient_information",
        }

    graph = StateGraph(AssistState)
    graph.add_node("rerank", node_rerank)
    graph.add_node("insufficient", node_insufficient)
    graph.add_node("generate", node_generate)
    graph.add_node("validate", node_validate)
    graph.add_edge(START, "rerank")
    graph.add_conditional_edges(
        "rerank", decide, {"generate": "generate", "insufficient": "insufficient"}
    )
    graph.add_edge("insufficient", END)
    graph.add_edge("generate", "validate")
    graph.add_edge("validate", END)
    return graph.compile(checkpointer=InMemorySaver()), totals


def build_brief_agent(llm: LLMProvider):
    totals = RunTotals()

    async def node_generate(state: AssistState) -> AssistState:
        if not state["sources"]:
            return {"raw": {}}
        try:
            res = await _call(
                llm,
                totals,
                state,
                "doctor_brief",
                BRIEF_SYSTEM,
                BRIEF_SCHEMA,
                sources_message(state["sources"]),
            )
        except LLMError as exc:
            return {"raw": {}, "error_kind": exc.kind.value}
        if res.stop_reason is not StopReason.END or not isinstance(res.json_output, dict):
            return {"raw": {}, "error_kind": "refused"}
        return {"raw": res.json_output}

    async def node_validate(state: AssistState) -> AssistState:
        sections, removed = [], 0
        for section in state.get("raw", {}).get("sections") or []:
            kept, dropped = validate_sentences(section.get("sentences") or [], state["sources"])
            removed += dropped
            if kept:
                sections.append(
                    {"heading": str(section.get("heading", ""))[:80], "sentences": kept}
                )
        status = (
            "ready"
            if sections
            else ("failed" if state.get("error_kind") else "insufficient_information")
        )
        return {"sections": sections, "removed": removed, "status": status}

    graph = StateGraph(AssistState)
    graph.add_node("generate", node_generate)
    graph.add_node("validate", node_validate)
    graph.add_edge(START, "generate")
    graph.add_edge("generate", "validate")
    graph.add_edge("validate", END)
    return graph.compile(checkpointer=InMemorySaver()), totals
