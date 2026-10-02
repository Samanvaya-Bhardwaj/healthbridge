"""Document agent (ADR-0011, ADR-0022): a fixed LangGraph workflow, no tools.

    extract_text ─► (no text) ─────────────────────────────► END
         │
         ▼
      classify ─► extract ─► validate ─► END

Classification and extraction are the only LLM steps; both get the document as
delimited, untrusted data and neither has tools, so instructions inside a document cannot
cause any action. The validate step keeps only grounded fields (ADR-0010). Persistence is
done by the caller in one patient-scoped transaction.
"""

import re
from datetime import date, datetime
from typing import Any, TypedDict

from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, StateGraph

from app.agents.prompts import (
    CLASSIFY_SCHEMA,
    CLASSIFY_SYSTEM,
    DOCUMENT_TYPES,
    EXTRACT_SCHEMA,
    EXTRACT_SYSTEM,
    document_message,
)
from app.documents.grounding import detect_injection, validate_fields
from app.documents.text import extract_text
from app.llm.base import LLMError, LLMMessage, LLMProvider, LLMRequest, ModelTier, StopReason
from app.repositories.ai_store import RunTotals

MAX_LLM_TEXT_CHARS = 60_000


class DocumentState(TypedDict, total=False):
    run_id: str
    request_id: str | None
    content: bytes
    content_type: str
    declared_type: str
    text: str
    text_source: str
    injection_flags: list[str]
    classification: dict[str, Any]
    raw: dict[str, Any]
    fields: list[dict[str, Any]]
    dropped: int
    status: str
    validation: str
    error_kind: str | None


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")[:40] or "item"


def _number(value: str) -> float | None:
    try:
        return float(value.lstrip("<>").strip())
    except ValueError:
        return None


def _flag(value: str, reference: str | None) -> str | None:
    """Deterministic low/normal/high from a numeric value and an "a-b" range."""
    v = _number(value)
    # Hyphen or en dash between bounds.
    m = re.match(
        r"^\s*(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)\s*$",  # noqa: RUF001
        reference or "",
    )
    if v is None or not m:
        return None
    low, high = float(m[1]), float(m[2])
    return "low" if v < low else "high" if v > high else "normal"


def _iso_date(value: str) -> str | None:
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y", "%d %b %Y", "%d %B %Y"):
        try:
            parsed = datetime.strptime(value.strip(), fmt).date()
        except ValueError:
            continue
        if date(1950, 1, 1) <= parsed <= date.today():
            return parsed.isoformat()
    return None


def flatten(raw: dict[str, Any]) -> list[dict[str, Any]]:
    """Model output → provider-neutral proposed fields (each with value + quote)."""
    fields: list[dict[str, Any]] = []
    if isinstance(raw.get("documentDate"), dict):
        fields.append({"key": "document_date", "kind": "document_date", **raw["documentDate"]})
    if isinstance(raw.get("issuer"), dict):
        fields.append({"key": "issuer", "kind": "issuer", **raw["issuer"]})
    for i, lab in enumerate(raw.get("labResults") or []):
        if not isinstance(lab, dict):
            continue
        fields.append(
            {
                "key": f"lab-{i}-{_slug(str(lab.get('analyte', '')))}",
                "kind": "lab_result",
                "analyte": str(lab.get("analyte", ""))[:120],
                "value": str(lab.get("value", ""))[:60],
                "unit": (lab.get("unit") or None),
                "referenceRange": (lab.get("referenceRange") or None),
                "quote": str(lab.get("quote", "")),
            }
        )
    return fields


def build_document_agent(llm: LLMProvider):
    totals = RunTotals()

    async def node_extract_text(state: DocumentState) -> DocumentState:
        extracted = extract_text(state["content"], state["content_type"])
        return {
            "text": extracted.text,
            "text_source": extracted.source,
            "injection_flags": detect_injection(extracted.text),
        }

    def route_after_text(state: DocumentState) -> str:
        return "classify" if state["text"].strip() else "no_text"

    async def node_no_text(state: DocumentState) -> DocumentState:
        return {
            "classification": {
                "documentType": state["declared_type"],
                "confidence": None,
                "source": "declared",
            },
            "fields": [],
            "dropped": 0,
            "status": "no_text",
            "validation": "schema_valid",
        }

    async def call(state: DocumentState, workflow: str, system: str, schema: dict, tier: ModelTier):
        response = await llm.generate(
            LLMRequest(
                workflow=workflow,
                system=system,
                messages=[
                    LLMMessage(
                        role="user", content=document_message(state["text"][:MAX_LLM_TEXT_CHARS])
                    )
                ],
                json_schema=schema,
                tier=tier,
                max_tokens=4096,
                run_id=state["run_id"],
                request_id=state.get("request_id"),
            )
        )
        totals.add(response)
        return response

    async def node_classify(state: DocumentState) -> DocumentState:
        try:
            res = await call(
                state, "document_classification", CLASSIFY_SYSTEM, CLASSIFY_SCHEMA, ModelTier.FAST
            )
            out = res.json_output if isinstance(res.json_output, dict) else {}
            doc_type = out.get("documentType")
            if res.stop_reason is StopReason.END and doc_type in DOCUMENT_TYPES:
                confidence = float(out.get("confidence") or 0)
                return {
                    "classification": {
                        "documentType": doc_type,
                        "confidence": max(0.0, min(1.0, confidence)),
                        "source": "model",
                    }
                }
        except LLMError:
            pass  # classification is advisory: fall back to the uploader's declared type
        return {
            "classification": {
                "documentType": state["declared_type"],
                "confidence": None,
                "source": "declared",
            }
        }

    async def node_extract(state: DocumentState) -> DocumentState:
        try:
            res = await call(
                state, "document_extraction", EXTRACT_SYSTEM, EXTRACT_SCHEMA, ModelTier.DEFAULT
            )
        except LLMError as exc:
            return {"raw": {}, "status": "failed", "error_kind": exc.kind.value}
        if res.stop_reason is StopReason.REFUSAL:
            return {"raw": {}, "status": "failed", "error_kind": "refused"}
        return {"raw": res.json_output if isinstance(res.json_output, dict) else {}}

    async def node_validate(state: DocumentState) -> DocumentState:
        if state.get("status") == "failed":
            return {"fields": [], "dropped": 0, "validation": "rejected"}
        proposed = flatten(state.get("raw") or {})
        kept, dropped = validate_fields(proposed, state["text"])
        for field in kept:
            if field["kind"] == "lab_result":
                field["valueNumeric"] = _number(field["value"])
                field["flag"] = _flag(field["value"], field.get("referenceRange"))
            if field["kind"] == "document_date":
                field["isoDate"] = _iso_date(field["value"])
        review = state["text_source"] == "ocr" or bool(state["injection_flags"])
        return {
            "fields": kept,
            "dropped": dropped,
            "status": "needs_clinician_review" if review else "completed",
            "validation": "partially_grounded" if dropped else "grounded",
        }

    graph = StateGraph(DocumentState)
    graph.add_node("extract_text", node_extract_text)
    graph.add_node("no_text", node_no_text)
    graph.add_node("classify", node_classify)
    graph.add_node("extract", node_extract)
    graph.add_node("validate", node_validate)
    graph.add_edge(START, "extract_text")
    graph.add_conditional_edges(
        "extract_text", route_after_text, {"classify": "classify", "no_text": "no_text"}
    )
    graph.add_edge("no_text", END)
    graph.add_edge("classify", "extract")
    graph.add_edge("extract", "validate")
    graph.add_edge("validate", END)
    return graph.compile(checkpointer=InMemorySaver()), totals
