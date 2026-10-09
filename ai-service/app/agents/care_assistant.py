"""Care assistant: a bounded LangGraph planner over backend-executed tools (M13.1, ADR-0029).

One HTTP call runs one *step* of a turn. The backend owns the turn loop: it sends the
person's message (first step) or the result of a tool it executed (next steps), and this
graph returns the updated structured state and the next action — a request for one
backend tool, or a reply. The AI service holds no state between calls, executes nothing
and never calls the backend.

    START ─┬─(tool result)─► observe ─────────────────────────────┐
           └─(message)────► safety ─┬─(possible emergency)─► END  ▼
                                    └─► understand ─► validate ─► route ─► END
                                                         └─(invalid output)─► END

- `safety` is deterministic (fixed 112/108 guidance; no model call).
- `understand` is the only model call: a fixed JSON form (intent and non-diagnostic
  preferences). The model writes no free text that reaches the person.
- `validate` accepts only enum values, the backend's specialty list and dates the
  backend resolved; anything else is dropped.
- `route` composes tool arguments in code, from validated state. The model never writes
  tool arguments, never sees a patient identifier and cannot add tools.
- Replies are fixed templates whose cards reference only IDs that backend tools returned.
"""

import re
from datetime import date
from typing import Any, Literal, TypedDict

from langgraph.graph import END, START, StateGraph
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.agents.care_prompts import (
    INTENT_SYSTEM,
    INTENTS,
    MODES,
    TIME_WINDOWS,
    WEEKDAYS,
    intent_schema,
    message_block,
)
from app.agents.care_safety import EMERGENCY_MESSAGE, is_possible_emergency
from app.llm.base import LLMError, LLMMessage, LLMProvider, LLMRequest, ModelTier, StopReason
from app.repositories.ai_store import RunTotals

MAX_TOOL_ROUNDS = 3
SEARCHING = ("find_doctor", "book_appointment")
TOOLS = (
    "getPatientContext",
    "getPatientCareTeam",
    "searchDoctors",
    "getDoctorProfile",
    "findAvailableSlots",
)
ToolName = Literal[
    "getPatientContext",
    "getPatientCareTeam",
    "searchDoctors",
    "getDoctorProfile",
    "findAvailableSlots",
]
Uuid = str
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_LANGUAGE = re.compile(r"^[A-Za-z][A-Za-z ]{1,29}$")
_CITY = re.compile(r"^[A-Za-z][A-Za-z .'-]{1,39}$")
_NAME = re.compile(r"^[A-Za-z][A-Za-z .'-]{1,59}$")
_TITLE = re.compile(r"^(dr\.?|doctor)\s+", re.I)

# Non-diagnostic wording: which kind of doctor usually sees an area of concern.
SPECIALTY_PHRASE = {
    "Dermatology": "Skin concerns are usually seen by dermatologists.",
    "Paediatrics": "Children are usually seen by paediatricians.",
    "Ophthalmology": "Eye concerns are usually seen by ophthalmologists.",
    "ENT": "Ear, nose and throat concerns are usually seen by ENT doctors.",
    "Cardiology": "Heart concerns are usually seen by cardiologists.",
    "Orthopaedics": "Bone and joint concerns are usually seen by orthopaedic doctors.",
    "Gynaecology": "Women's health concerns are usually seen by gynaecologists.",
    "Psychiatry": "Mental health concerns are usually seen by psychiatrists.",
    "Neurology": "Concerns about the nerves and brain are usually seen by neurologists.",
    "Gastroenterology": "Stomach and digestion concerns are usually seen by gastroenterologists.",
    "Endocrinology": "Hormone concerns are usually seen by endocrinologists.",
    "Pulmonology": "Lung concerns are usually seen by pulmonologists.",
    "General Medicine": "A general physician is a good first step.",
    "Family Medicine": "A family doctor is a good first step.",
}


# ── Contracts (mirrors @healthbridge/shared careAssistantStateSchema) ─────────────


class Criteria(BaseModel):
    model_config = ConfigDict(extra="forbid")
    specialty: str | None = None
    consultationMode: Literal["online", "in_clinic"] | None = None
    date: str | None = None
    timeWindow: Literal["morning", "afternoon", "evening"] | None = None
    language: str | None = None
    city: str | None = None
    doctorName: str | None = None


class CareState(BaseModel):
    model_config = ConfigDict(extra="forbid")
    v: Literal[1] = 1
    intent: Literal[*INTENTS] | None = None  # type: ignore[valid-type]
    criteria: Criteria = Field(default_factory=Criteria)
    # The kind of doctor was inferred from a described concern (for the fixed,
    # non-diagnostic "usually seen by" sentence). A flag only; never the concern itself.
    specialtyFromConcern: bool = False
    careTeamDoctorIds: list[Uuid] = Field(default_factory=list, max_length=20)
    candidateDoctorIds: list[Uuid] = Field(default_factory=list, max_length=5)
    selectedDoctorId: Uuid | None = None
    slotStarts: list[str] = Field(default_factory=list, max_length=6)
    lastTools: list[ToolName] = Field(default_factory=list, max_length=6)


class StepContext(BaseModel):
    """Calendar facts the backend resolved in the person's time zone."""

    model_config = ConfigDict(extra="forbid")
    today: date
    tomorrow: date
    weekdays: dict[str, date]  # next occurrence of each weekday, from today
    horizon: date  # last bookable day
    specialties: list[str] = Field(min_length=1, max_length=40)
    actingFor: Literal["self", "dependent"] = "self"


class ToolResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: ToolName
    ok: bool
    errorCode: str | None = Field(default=None, pattern=r"^[a-z_]{1,48}$")
    data: dict[str, Any] = Field(default_factory=dict)


class Card(BaseModel):
    type: Literal["doctor", "slot", "link"]
    doctorId: Uuid | None = None
    startsAt: str | None = None
    target: Literal["my_doctors", "appointments", "records", "prescriptions"] | None = None


class Reply(BaseModel):
    kind: Literal["answer", "clarify", "emergency", "fallback", "not_yet", "help"]
    message: str
    cards: list[Card] = Field(default_factory=list, max_length=12)


class GraphState(TypedDict, total=False):
    run_id: str
    request_id: str | None
    state: CareState
    context: StepContext
    message: str | None
    tool_result: ToolResult | None
    tools_this_turn: list[str]
    raw: Any
    tool_failed: bool
    action: dict[str, Any]
    reply: Reply | None
    error_kind: str | None
    llm_called: bool


# ── Helpers ─────────────────────────────────────────────────────────────────────


def _clean(value: Any, pattern: re.Pattern[str]) -> str | None:
    if not isinstance(value, str):
        return None
    value = " ".join(value.split())
    return value if pattern.match(value) else None


def _resolve_day(raw: dict[str, Any], ctx: StepContext) -> str | None:
    kind = raw.get("dayKind")
    if kind == "today":
        return ctx.today.isoformat()
    if kind == "tomorrow":
        return ctx.tomorrow.isoformat()
    if kind == "weekday":
        day = ctx.weekdays.get(str(raw.get("weekday") or "").lower())
        return day.isoformat() if day else None
    if kind == "date":
        try:
            day = date.fromisoformat(str(raw.get("date") or ""))
        except ValueError:
            return None
        return day.isoformat() if ctx.today <= day <= ctx.horizon else None
    return None


def _uuid_list(items: Any, limit: int) -> list[str]:
    out: list[str] = []
    for item in items if isinstance(items, list) else []:
        if isinstance(item, str) and _UUID.match(item) and item not in out:
            out.append(item)
    return out[:limit]


def _day_label(iso: str | None) -> str:
    if not iso:
        return ""
    d = date.fromisoformat(iso)
    return f"{d.strftime('%A')}, {d.day} {d.strftime('%B')}"


def _plural(n: int, one: str, many: str) -> str:
    return f"{n} {one if n == 1 else many}"


# ── Graph ───────────────────────────────────────────────────────────────────────


def build_care_assistant(llm: LLMProvider):
    totals = RunTotals()

    def start(state: GraphState) -> str:
        return "observe" if state.get("tool_result") else "safety"

    async def node_safety(state: GraphState) -> GraphState:
        if is_possible_emergency(state.get("message") or ""):
            return {
                "action": {"type": "respond"},
                "reply": Reply(
                    kind="emergency",
                    message=EMERGENCY_MESSAGE,
                ),
            }
        return {}

    def after_safety(state: GraphState) -> str:
        return END if state.get("reply") else "understand"

    async def node_understand(state: GraphState) -> GraphState:
        ctx = state["context"]
        try:
            response = await llm.generate(
                LLMRequest(
                    workflow="care_assistant_intent",
                    system=INTENT_SYSTEM,
                    messages=[
                        LLMMessage(
                            role="user",
                            content=message_block(state["message"] or "", ctx.specialties),
                        )
                    ],
                    json_schema=intent_schema(ctx.specialties),
                    tier=ModelTier.FAST,
                    max_tokens=300,
                    run_id=state["run_id"],
                    request_id=state.get("request_id"),
                )
            )
        except LLMError as exc:
            return {"raw": None, "error_kind": exc.kind.value, "llm_called": True}
        totals.add(response)
        if response.stop_reason is not StopReason.END or not isinstance(response.json_output, dict):
            return {"raw": None, "error_kind": "invalid_output", "llm_called": True}
        return {"raw": response.json_output, "llm_called": True}

    async def node_validate(state: GraphState) -> GraphState:
        raw, ctx, current = state.get("raw"), state["context"], state["state"]
        if not isinstance(raw, dict) or raw.get("intent") not in INTENTS:
            return {
                "error_kind": state.get("error_kind") or "invalid_output",
                "action": {"type": "respond"},
                "reply": Reply(
                    kind="fallback",
                    message=(
                        "I couldn't understand that just now. You can still find a doctor and "
                        "book a time in My Doctors."
                    ),
                    cards=[Card(type="link", target="my_doctors")],
                ),
            }
        allowed = {s.lower(): s for s in ctx.specialties}
        specialty = allowed.get(str(raw.get("specialty") or "").lower())
        mode = raw.get("consultationMode") if raw.get("consultationMode") in MODES else None
        window = raw.get("timeWindow") if raw.get("timeWindow") in TIME_WINDOWS else None
        if raw.get("weekday") not in (None, *WEEKDAYS):
            raw = {**raw, "weekday": None}
        name = _clean(raw.get("doctorName"), _NAME)
        found = Criteria(
            specialty=specialty,
            consultationMode=mode,
            date=_resolve_day(raw, ctx),
            timeWindow=window,
            language=(_clean(raw.get("language"), _LANGUAGE) or "").title() or None,
            city=(_clean(raw.get("city"), _CITY) or "").title() or None,
            doctorName=_TITLE.sub("", name) if name else None,
        )
        # New details refine the previous ones; a different doctor search starts afresh.
        merged = current.criteria.model_copy(
            update={k: v for k, v in found.model_dump().items() if v is not None}
        )
        search_changed = any(
            getattr(merged, k) != getattr(current.criteria, k)
            for k in ("specialty", "doctorName", "language")
        )
        day_changed = any(
            getattr(merged, k) != getattr(current.criteria, k)
            for k in ("date", "timeWindow", "consultationMode")
        )
        intent = raw["intent"]
        refinement = any(v is not None for v in found.model_dump().values())
        if intent in ("unsupported", "greeting") and refinement and current.intent in SEARCHING:
            # "tomorrow evening" on its own refines the search already under way.
            intent = current.intent
        update: dict[str, Any] = {"intent": intent, "criteria": merged}
        if specialty is not None:
            update["specialtyFromConcern"] = bool(raw.get("specialtyFromConcern"))
        if search_changed:
            update.update(candidateDoctorIds=[], selectedDoctorId=None, slotStarts=[])
        elif day_changed:
            update.update(slotStarts=[])
        return {"state": current.model_copy(update=update)}

    def after_validate(state: GraphState) -> str:
        return END if state.get("reply") else "route"

    async def node_observe(state: GraphState) -> GraphState:
        result, current = state["tool_result"], state["state"]
        if result is None or not result.ok:
            return {"tool_failed": True}
        data = result.data
        if result.name == "getPatientCareTeam":
            active = [
                d.get("doctorId")
                for d in data.get("doctors", [])
                if isinstance(d, dict) and d.get("status") == "active"
            ]
            team = _uuid_list(active, 20)
            return {"state": current.model_copy(update={"careTeamDoctorIds": team})}
        if result.name == "searchDoctors":
            rows = [d for d in data.get("doctors", []) if isinstance(d, dict)]
            ordered = [d.get("doctorId") for d in rows if d.get("inCareTeam")] + [
                d.get("doctorId") for d in rows if not d.get("inCareTeam")
            ]
            return {
                "state": current.model_copy(
                    update={"candidateDoctorIds": _uuid_list(ordered, 5), "slotStarts": []}
                )
            }
        if result.name == "findAvailableSlots":
            doctor = data.get("doctorId")
            if not (isinstance(doctor, str) and _UUID.match(doctor)):
                return {"tool_failed": True}
            starts = [
                s.get("startsAt")
                for s in data.get("slots", [])
                if isinstance(s, dict) and isinstance(s.get("startsAt"), str)
            ][:6]
            return {
                "state": current.model_copy(
                    update={"selectedDoctorId": doctor, "slotStarts": starts}
                )
            }
        return {}

    async def node_route(state: GraphState) -> GraphState:
        current, ctx = state["state"], state["context"]
        used = list(state.get("tools_this_turn") or [])
        crit = current.criteria
        theirs = "their" if ctx.actingFor == "dependent" else "your"

        def tool(name: str, args: dict[str, Any]) -> GraphState:
            return {"action": {"type": "tool", "tool": name, "args": args}, "reply": None}

        def respond(kind: str, message: str, cards: list[Card] | None = None) -> GraphState:
            return {
                "action": {"type": "respond"},
                "reply": Reply(kind=kind, message=message, cards=cards or []),
                "state": current.model_copy(update={"lastTools": used[-6:]}),
            }

        intent = current.intent
        if intent in SEARCHING:
            wants_search = bool(crit.specialty or crit.doctorName or crit.language)
            if len(used) < MAX_TOOL_ROUNDS and not state.get("tool_failed"):
                if "getPatientCareTeam" not in used:
                    return tool("getPatientCareTeam", {})
                if wants_search and "searchDoctors" not in used:
                    args = {
                        k: v
                        for k, v in {
                            "specialty": crit.specialty,
                            "name": crit.doctorName,
                            "language": crit.language,
                        }.items()
                        if v
                    }
                    return tool("searchDoctors", args)
                if (
                    current.candidateDoctorIds
                    and (crit.date or crit.timeWindow)
                    and "findAvailableSlots" not in used
                ):
                    args = {"doctorId": current.candidateDoctorIds[0]}
                    if crit.date:
                        args["date"] = crit.date
                    if crit.timeWindow:
                        args["timeWindow"] = crit.timeWindow
                    if crit.consultationMode:
                        args["mode"] = crit.consultationMode
                    return tool("findAvailableSlots", args)
            if state.get("tool_failed"):
                return respond(
                    "fallback",
                    "I couldn't finish looking that up. You can still find a doctor in My Doctors.",
                    [Card(type="link", target="my_doctors")],
                )
            if not wants_search:
                team = [Card(type="doctor", doctorId=d) for d in current.careTeamDoctorIds[:3]]
                extra = f" Or choose a doctor already in {theirs} care team." if team else ""
                return respond(
                    "clarify",
                    "What kind of doctor are you looking for? You can describe it in your own "
                    "words, for example “a skin doctor tomorrow evening”." + extra,
                    team,
                )
            parts: list[str] = []
            if current.specialtyFromConcern and crit.specialty in SPECIALTY_PHRASE:
                parts.append(SPECIALTY_PHRASE[crit.specialty])
            candidates = current.candidateDoctorIds
            if not candidates:
                parts.append(
                    "I couldn't find a verified doctor matching that. Try another kind of "
                    "doctor, or browse all doctors in My Doctors."
                )
                return respond("answer", " ".join(parts), [Card(type="link", target="my_doctors")])
            one = len(candidates) == 1
            parts.append(
                f"Here {'is' if one else 'are'} "
                f"{_plural(len(candidates), 'verified doctor', 'verified doctors')} "
                f"who {'matches' if one else 'match'}."
                + ("" if one else f" Doctors already in {theirs} care team are listed first.")
            )
            cards = [Card(type="doctor", doctorId=d) for d in candidates]
            if "findAvailableSlots" in used and current.selectedDoctorId:
                when = " ".join(
                    filter(
                        None,
                        [
                            f"on {_day_label(crit.date)}" if crit.date else "",
                            f"in the {crit.timeWindow}" if crit.timeWindow else "",
                        ],
                    )
                )
                if current.slotStarts:
                    parts.append(f"Free times with the first doctor {when}:".replace("  ", " "))
                    cards += [
                        Card(type="slot", doctorId=current.selectedDoctorId, startsAt=s)
                        for s in current.slotStarts
                    ]
                else:
                    parts.append(
                        f"The first doctor has no free times {when}. Try another day or time."
                    )
            elif crit.date or crit.timeWindow:
                parts.append("Tell me which doctor you'd like, and I'll look for free times.")
            if intent == "book_appointment":
                parts.append(
                    "Booking happens on the booking page: choose a time to continue. "
                    "You can book once a doctor has accepted you into their care team."
                )
            return respond("answer", " ".join(parts), cards)
        if intent == "view_appointments":
            return respond(
                "answer",
                f"{theirs.capitalize()} appointments are on the Appointments page.",
                [Card(type="link", target="appointments")],
            )
        if intent in ("reschedule", "cancel"):
            return respond(
                "not_yet",
                "I can't change appointments here yet. Open the appointment from the "
                "Appointments page to reschedule or cancel it.",
                [Card(type="link", target="appointments")],
            )
        if intent == "ask_records":
            return respond(
                "not_yet",
                "I can't answer questions about records here yet. Documents and results are in "
                "Health Records.",
                [Card(type="link", target="records")],
            )
        if intent == "view_medications":
            return respond(
                "not_yet",
                "Signed prescriptions, with how to take each medicine, are on the "
                "Prescriptions page.",
                [Card(type="link", target="prescriptions")],
            )
        if intent == "greeting":
            return respond(
                "help",
                "Hello! I can help you find a doctor and see when they're free. Tell me what "
                "kind of doctor you need, and when.",
            )
        return respond(
            "help",
            "I can help you find a doctor and see free times. For anything else, please use "
            "the menu.",
        )

    graph = StateGraph(GraphState)
    graph.add_node("safety", node_safety)
    graph.add_node("understand", node_understand)
    graph.add_node("validate", node_validate)
    graph.add_node("observe", node_observe)
    graph.add_node("route", node_route)
    graph.add_conditional_edges(START, start, {"observe": "observe", "safety": "safety"})
    graph.add_conditional_edges("safety", after_safety, {END: END, "understand": "understand"})
    graph.add_edge("understand", "validate")
    graph.add_conditional_edges("validate", after_validate, {END: END, "route": "route"})
    graph.add_edge("observe", "route")
    graph.add_edge("route", END)
    # No checkpointer: the service is stateless; the backend persists CareState.
    return graph.compile(), totals


def parse_state(raw: Any) -> CareState:
    """Never trust state from the wire: strict parse, else start clean."""
    try:
        return CareState.model_validate(raw or {})
    except ValidationError:
        return CareState()
