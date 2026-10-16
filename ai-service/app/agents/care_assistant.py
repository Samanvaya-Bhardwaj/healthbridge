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
from datetime import date, datetime, timedelta
from typing import Any, Literal, TypedDict

from langgraph.graph import END, START, StateGraph
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.agents.care_prompts import (
    CRITERIA,
    INTENT_SYSTEM,
    INTENTS,
    MODES,
    TIME_WINDOWS,
    UNSUPPORTED,
    WEEKDAYS,
    intent_schema,
    message_block,
)
from app.agents.care_safety import EMERGENCY_MESSAGE, is_possible_emergency
from app.llm.base import LLMError, LLMMessage, LLMProvider, LLMRequest, ModelTier, StopReason
from app.repositories.ai_store import RunTotals

MAX_TOOL_ROUNDS = 3
# Step 6: at most this many clarifying questions in a row; then search.
MAX_CLARIFY_TURNS = 2
ANY_DOCTOR_CHOICE = "Any kind of doctor is fine"
# Honest answers for preferences HealthBridge cannot search by (fixed wording).
UNSUPPORTED_TEXT = {
    "gender": "I can't choose doctors by gender: HealthBridge doesn't record it.",
    "age": "I can't choose doctors by age.",
    "fees": "I can't filter by fee yet: each doctor's fee is shown before you book.",
    "ratings": "HealthBridge doesn't rate doctors.",
    "insurance": "HealthBridge doesn't record insurance.",
    "other": "I can't search by that.",
}
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
    # M13.2: areas of practice (codes from the backend's list) that fit the specialty.
    areas: list[str] = Field(default_factory=list, max_length=3)
    consultationMode: Literal["online", "in_clinic"] | None = None
    date: str | None = None
    timeWindow: Literal["morning", "afternoon", "evening"] | None = None
    language: str | None = None
    city: str | None = None
    doctorName: str | None = None


class PendingChoice(BaseModel):
    """An open question: which kind of doctor, when several fit and none was named."""

    model_config = ConfigDict(extra="forbid")
    kind: Literal["specialty"] = "specialty"
    options: list[str] = Field(min_length=2, max_length=3)


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
    # Step 6: doctors not to show again, an open question, how many in a row, and
    # criteria the person said they do not mind.
    excludedDoctorIds: list[Uuid] = Field(default_factory=list, max_length=20)
    pendingChoice: PendingChoice | None = None
    clarifyTurns: int = Field(default=0, ge=0, le=MAX_CLARIFY_TURNS)
    removed: list[Literal[*CRITERIA]] = Field(default_factory=list, max_length=6)  # type: ignore[valid-type]
    notices: list[Literal[*UNSUPPORTED]] = Field(default_factory=list, max_length=6)  # type: ignore[valid-type]
    # Booking in the conversation (ADR-0038): the doctor the person chose, the time they
    # picked from those offered, and a clock time they asked for in words. A picked time
    # becomes a proposal in the backend; only the person's Confirm books it.
    bookingDoctorId: Uuid | None = None
    chosenStart: str | None = None
    requestedTime: str | None = Field(default=None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$")


class Selection(BaseModel):
    """A tap on an option the assistant offered: applied by code, with no model call."""

    model_config = ConfigDict(extra="forbid")
    kind: Literal["doctor", "slot"]
    doctorId: Uuid
    startsAt: str | None = Field(default=None, max_length=40)


class AreaRef(BaseModel):
    """An area of practice the AI may choose: code, label, kinds of doctor that cover it."""

    model_config = ConfigDict(extra="forbid")
    code: str = Field(pattern=r"^[a-z_]{2,40}$")
    label: str = Field(min_length=2, max_length=60)
    specialties: list[str] = Field(default_factory=list, max_length=20)


class StepContext(BaseModel):
    """Calendar facts the backend resolved in the person's time zone."""

    model_config = ConfigDict(extra="forbid")
    today: date
    tomorrow: date
    weekdays: dict[str, date]  # next occurrence of each weekday, from today
    horizon: date  # last bookable day
    specialties: list[str] = Field(min_length=1, max_length=40)
    areas: list[AreaRef] = Field(default_factory=list, max_length=120)
    actingFor: Literal["self", "dependent"] = "self"
    # The person's offset from UTC now (their own time zone), for "at 10:30".
    utcOffsetMinutes: int = Field(default=0, ge=-720, le=840)


class ToolResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: ToolName
    ok: bool
    errorCode: str | None = Field(default=None, pattern=r"^[a-z_]{1,48}$")
    data: dict[str, Any] = Field(default_factory=dict)


class Card(BaseModel):
    type: Literal["doctor", "slot", "link", "choice", "booking"]
    doctorId: Uuid | None = None
    startsAt: str | None = None
    target: Literal["my_doctors", "appointments", "records", "prescriptions"] | None = None
    # Step 6: an answer the person can tap (sent back as their next message).
    value: str | None = None


class Reply(BaseModel):
    kind: Literal["answer", "clarify", "confirm", "emergency", "fallback", "not_yet", "help"]
    message: str
    cards: list[Card] = Field(default_factory=list, max_length=12)


class GraphState(TypedDict, total=False):
    run_id: str
    request_id: str | None
    state: CareState
    context: StepContext
    message: str | None
    tool_result: ToolResult | None
    selection: Selection | None
    stale_selection: bool
    tools_this_turn: list[str]
    raw: Any
    tool_failed: bool
    tool_error: str | None
    search_status: str | None
    unsupported: list[str]
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


# Explicit words in the message, read by code. Small local models misread these often, and
# they are unambiguous, so code corrects the form for them (the model keeps the rest).
_WEEKDAY_WORD = re.compile(r"\b(" + "|".join(WEEKDAYS) + r")\b", re.I)
_NEGATED = re.compile(r"\b(not|no|don'?t|without)\s+(an?\s+)?$", re.I)
_CUES: list[tuple[str, str, re.Pattern[str]]] = [
    (
        "consultationMode",
        "online",
        re.compile(r"\b(online|video( call| consult\w*)?|tele\w*)\b", re.I),
    ),
    (
        "consultationMode",
        "in_clinic",
        re.compile(
            r"\b(in[- ]clinic|in[- ]person|at the clinic|visit the clinic|clinic visit)\b", re.I
        ),
    ),
    ("timeWindow", "morning", re.compile(r"\bmorning\b", re.I)),
    ("timeWindow", "afternoon", re.compile(r"\bafternoon\b", re.I)),
    ("timeWindow", "evening", re.compile(r"\b(evening|night)\b", re.I)),
]


def _not_negated(text: str, match: re.Match[str]) -> bool:
    return not _NEGATED.search(text[max(0, match.start() - 16) : match.start()])


def _explicit_cues(message: str, raw: dict[str, Any]) -> dict[str, Any]:
    """The form, corrected for unambiguous words: weekday, today/tomorrow, mode, window."""
    fixed = dict(raw)
    text = message or ""
    if (m := _WEEKDAY_WORD.search(text)) and _not_negated(text, m):
        fixed.update(dayKind="weekday", weekday=m.group(1).lower(), date=None)
    elif re.search(r"\btomorrow\b", text, re.I):
        fixed.update(dayKind="tomorrow", weekday=None, date=None)
    elif re.search(r"\btoday\b", text, re.I):
        fixed.update(dayKind="today", weekday=None, date=None)
    found: dict[str, list[str]] = {}
    for field, value, pattern in _CUES:
        m = pattern.search(text)
        if m and _not_negated(text, m):
            found.setdefault(field, []).append(value)
    for field, values in found.items():
        if len(set(values)) == 1:  # "online or in person" is not a preference
            fixed[field] = values[0]
    return fixed


_CLOCK = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")


def _clock(value: Any) -> str | None:
    """A clock time as HH:MM (24-hour), or None."""
    m = _CLOCK.match(value.strip()) if isinstance(value, str) else None
    return f"{int(m.group(1)):02d}:{m.group(2)}" if m else None


def _local_hhmm(iso: str, ctx: "StepContext") -> str | None:
    try:
        at = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return None
    return (at + timedelta(minutes=ctx.utcOffsetMinutes)).strftime("%H:%M")


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


def _criteria_summary(crit: Criteria, ctx: StepContext) -> str:
    """What was searched for, in plain words (fixed phrasing; values are validated)."""
    labels = {a.code: a.label for a in ctx.areas}
    parts: list[str] = []
    if crit.specialty:
        parts.append(f"for {crit.specialty}")
    if crit.areas:
        listed = " or ".join(labels.get(a, a) for a in crit.areas)
        parts.append(f"who list {listed}")
    if crit.language:
        parts.append(f"who speak {crit.language}")
    if crit.city:
        parts.append(f"in {crit.city}")
    if crit.consultationMode:
        parts.append(
            "for online consultations"
            if crit.consultationMode == "online"
            else "for in-clinic visits"
        )
    if crit.doctorName:
        parts.append(f"named {crit.doctorName}")
    return ", ".join(parts)


def _relax_hint(crit: Criteria) -> str:
    """One concrete way to widen a search that found nobody (deterministic order)."""
    if crit.doctorName:
        return "Check the doctor's name, or search by kind of doctor instead."
    if crit.consultationMode:
        return "You could try both online and in-clinic visits."
    if crit.language:
        return "You could try without the language preference."
    if crit.city:
        return "You could try online consultations, or another city."
    if crit.areas:
        return "You could try any doctor of that kind."
    return "Try another kind of doctor, or browse all doctors in My Doctors."


def _plural(n: int, one: str, many: str) -> str:
    return f"{n} {one if n == 1 else many}"


# ── Graph ───────────────────────────────────────────────────────────────────────


def build_care_assistant(llm: LLMProvider):
    totals = RunTotals()

    def start(state: GraphState) -> str:
        if state.get("tool_result"):
            return "observe"
        return "select" if state.get("selection") else "safety"

    async def node_select(state: GraphState) -> GraphState:
        """A tap on an offered doctor or time: applied by code, no model call (ADR-0038)."""
        current, sel = state["state"], state["selection"]
        offered = {
            *current.candidateDoctorIds,
            *current.careTeamDoctorIds,
            *([current.bookingDoctorId] if current.bookingDoctorId else []),
        }
        cleared = {"pendingChoice": None, "clarifyTurns": 0, "notices": []}
        if sel.kind == "doctor" and sel.doctorId in offered:
            return {
                "state": current.model_copy(
                    update={
                        **cleared,
                        "intent": "book_appointment",
                        "bookingDoctorId": sel.doctorId,
                        "chosenStart": None,
                        "requestedTime": None,
                        "slotStarts": [],
                    }
                )
            }
        if (
            sel.kind == "slot"
            and sel.startsAt in current.slotStarts
            and sel.doctorId in {current.selectedDoctorId, current.bookingDoctorId}
        ):
            return {
                "state": current.model_copy(
                    update={
                        **cleared,
                        "intent": "book_appointment",
                        "bookingDoctorId": sel.doctorId,
                        "chosenStart": sel.startsAt,
                        "requestedTime": None,
                    }
                )
            }
        # Not one of the options offered (or no longer): say so and offer the current ones.
        return {
            "stale_selection": True,
            "state": current.model_copy(update={**cleared, "chosenStart": None}),
        }

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
                            content=message_block(
                                state["message"] or "",
                                ctx.specialties,
                                [(a.code, a.label) for a in ctx.areas],
                            ),
                        )
                    ],
                    json_schema=intent_schema(ctx.specialties, [a.code for a in ctx.areas]),
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
        raw = _explicit_cues(state.get("message") or "", raw)
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
        # Step 6: what the person no longer minds goes first ("any city").
        raw_remove = raw.get("remove") if isinstance(raw.get("remove"), list) else []
        removing = [c for c in dict.fromkeys(raw_remove) if c in CRITERIA]
        defaults = Criteria()
        base = current.criteria.model_copy(update={c: getattr(defaults, c) for c in removing})
        # A different kind of search starts afresh: a named doctor replaces the kind of
        # doctor (and its areas), and a new kind of doctor replaces a named one.
        if found.doctorName and not found.specialty:
            base = base.model_copy(update={"specialty": None, "areas": []})
        if found.specialty and found.specialty != base.specialty and not found.doctorName:
            base = base.model_copy(update={"doctorName": None})
        # New details refine the previous ones. A criterion removed in this message stays
        # removed even if the message also mentions it ("online or in person is fine").
        merged = base.model_copy(
            update={
                k: v
                for k, v in found.model_dump().items()
                if v is not None and k != "areas" and k not in removing
            }
        )
        # Areas: new ones replace the old; only known areas that fit the specialty stay.
        known = {a.code: a for a in ctx.areas}
        raw_areas = raw.get("areas") if isinstance(raw.get("areas"), list) else []
        picked = [a for a in raw_areas if isinstance(a, str) and a in known]
        areas = [
            a
            for a in dict.fromkeys(picked or base.areas)
            if a in known and (merged.specialty is None or merged.specialty in known[a].specialties)
        ][:3]
        merged = merged.model_copy(update={"areas": areas})
        stated = {
            k for k, v in found.model_dump().items() if v not in (None, []) and k not in removing
        }
        if picked:
            stated.add("areas")
        removed = [c for c in dict.fromkeys([*current.removed, *removing]) if c not in stated]

        # Step 6: a concern several kinds of doctor could see, none named: ask (bounded).
        raw_options = raw.get("specialtyOptions")
        options = [
            o
            for o in dict.fromkeys(
                str(x) for x in (raw_options if isinstance(raw_options, list) else [])
            )
            if o in set(ctx.specialties)
        ][:3]
        pending = None
        if (
            merged.specialty is None
            and len(options) >= 2
            and "specialty" not in removing
            and current.clarifyTurns < MAX_CLARIFY_TURNS
        ):
            pending = PendingChoice(options=options)

        # Step 6: "not this doctor, show me others" hides the doctors already shown.
        show_others = raw.get("showOthers") is True
        excluded = list(current.excludedDoctorIds)
        if show_others and current.candidateDoctorIds:
            excluded = list(dict.fromkeys([*excluded, *current.candidateDoctorIds]))[-20:]
        raw_unsupported = raw.get("unsupported") if isinstance(raw.get("unsupported"), list) else []
        notices = [u for u in dict.fromkeys(raw_unsupported) if u in UNSUPPORTED]

        search_changed = (
            any(
                getattr(merged, k) != getattr(current.criteria, k)
                for k in (
                    "specialty",
                    "areas",
                    "doctorName",
                    "language",
                    "city",
                    "consultationMode",
                )
            )
            or show_others
        )
        day_changed = any(
            getattr(merged, k) != getattr(current.criteria, k) for k in ("date", "timeWindow")
        )
        intent = raw["intent"]
        # ADR-0038: "the second one" picks a doctor already shown; "at 10:30" a time.
        pick = raw.get("pickDoctor")
        picked_doctor = (
            current.candidateDoctorIds[pick - 1]
            if isinstance(pick, int) and 1 <= pick <= len(current.candidateDoctorIds)
            else None
        )
        requested_time = _clock(raw.get("time"))
        refinement = bool(stated or removing or show_others or options or notices)
        if intent in ("unsupported", "greeting") and refinement and current.intent in SEARCHING:
            # "tomorrow evening" or "any city" on its own refines the search under way.
            intent = current.intent
        if intent in ("unsupported", "greeting") and (options or notices):
            # A described concern (or a preference) is a request for a doctor.
            intent = "find_doctor"
        update: dict[str, Any] = {
            "intent": intent,
            "criteria": merged,
            "pendingChoice": pending,
            "clarifyTurns": current.clarifyTurns + 1 if pending else 0,
            "removed": removed,
            "excludedDoctorIds": excluded,
            "notices": notices,
        }
        if specialty is not None:
            update["specialtyFromConcern"] = bool(raw.get("specialtyFromConcern"))
        elif "specialty" in removing:
            update["specialtyFromConcern"] = False
        booking_doctor = current.bookingDoctorId
        if picked_doctor:
            booking_doctor = picked_doctor
            update["intent"] = "book_appointment"
        if requested_time and (booking_doctor or current.slotStarts):
            update["intent"] = "book_appointment"
        if search_changed and not picked_doctor:
            update.update(candidateDoctorIds=[], selectedDoctorId=None, slotStarts=[])
            booking_doctor = None
        elif day_changed:
            update.update(slotStarts=[])
        # A picked time survives a plain "yes"; anything new means choosing again.
        keep_choice = not (search_changed or day_changed or requested_time or picked_doctor)
        update.update(
            bookingDoctorId=booking_doctor,
            chosenStart=current.chosenStart if keep_choice else None,
            requestedTime=requested_time,
        )
        if booking_doctor is None:
            update["chosenStart"] = None
        return {"state": current.model_copy(update=update)}

    def after_validate(state: GraphState) -> str:
        return END if state.get("reply") else "route"

    async def node_observe(state: GraphState) -> GraphState:
        result, current = state["tool_result"], state["state"]
        if result is None or not result.ok:
            return {"tool_failed": True, "tool_error": result.errorCode if result else None}
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
            # M13.3: the backend ranks (care team, past visits, preferences, soonest time);
            # the order is kept as given.
            rows = [d for d in data.get("doctors", []) if isinstance(d, dict)]
            ordered = [d.get("doctorId") for d in rows]
            return {
                "state": current.model_copy(
                    update={"candidateDoctorIds": _uuid_list(ordered, 5), "slotStarts": []}
                ),
                "search_status": "no_match" if data.get("status") == "no_match" else "ok",
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

        def respond(
            kind: str,
            message: str,
            cards: list[Card] | None = None,
            update: dict[str, Any] | None = None,
        ) -> GraphState:
            # Step 6: preferences that cannot be searched are answered honestly, up front.
            honest = " ".join(UNSUPPORTED_TEXT[n] for n in current.notices)
            return {
                "action": {"type": "respond"},
                "reply": Reply(kind=kind, message=f"{honest} {message}".strip(), cards=cards or []),
                "state": current.model_copy(update={"lastTools": used[-6:], **(update or {})}),
            }

        def propose(start: str) -> GraphState:
            # The backend re-checks the slot and builds the proposal; Confirm books it.
            return respond(
                "confirm",
                "Here's the booking. Check the details, then tap Confirm booking. "
                "Nothing is booked until you do.",
                [Card(type="booking", doctorId=current.bookingDoctorId, startsAt=start)],
                {"chosenStart": start, "requestedTime": None},
            )

        def booking_route() -> GraphState:
            """ADR-0038: with a chosen doctor, find times, take the person's pick, propose."""
            doctor = current.bookingDoctorId
            rounds = used.count("findAvailableSlots")
            if current.chosenStart and not state.get("stale_selection"):
                return propose(current.chosenStart)
            offered = current.slotStarts if current.selectedDoctorId == doctor else []
            if state.get("stale_selection") and offered and not used:
                # Not one of the times offered: offer those again (no new lookup needed).
                return respond(
                    "clarify",
                    "That time isn't available any more. Please pick one of these.",
                    [Card(type="slot", doctorId=doctor, startsAt=s) for s in offered],
                )
            if rounds == 0 and len(used) < MAX_TOOL_ROUNDS and not state.get("tool_failed"):
                args: dict[str, Any] = {"doctorId": doctor}
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
                    "I couldn't look up free times just now. Please try again in a moment.",
                )
            starts = current.slotStarts if current.selectedDoctorId == doctor else []
            if current.requestedTime and starts:
                matching = [s for s in starts if _local_hhmm(s, ctx) == current.requestedTime]
                if len(matching) == 1:
                    return propose(matching[0])
            if (
                not starts
                and (crit.date or crit.timeWindow)
                and rounds == 1
                and len(used) < MAX_TOOL_ROUNDS
            ):
                # Nothing then: look at the coming days instead.
                args = {"doctorId": doctor}
                if crit.consultationMode:
                    args["mode"] = crit.consultationMode
                return tool("findAvailableSlots", args)
            stale = "That time isn't available any more. " if state.get("stale_selection") else ""
            when = " ".join(
                filter(
                    None,
                    [
                        f"on {_day_label(crit.date)}" if crit.date else "",
                        f"in the {crit.timeWindow}" if crit.timeWindow else "",
                    ],
                )
            )
            if starts:
                lead = (
                    f"There are no free times {when}; here are the next ones."
                    if rounds == 2
                    else f"Here are the free times {when}.".replace("  ", " ").replace(" .", ".")
                )
                missed = (
                    f" {current.requestedTime} isn't free; please pick one of these."
                    if current.requestedTime
                    else ""
                )
                return respond(
                    "clarify",
                    f"{stale}{lead}{missed} Which time suits "
                    f"{'them' if ctx.actingFor == 'dependent' else 'you'}?",
                    [Card(type="slot", doctorId=doctor, startsAt=s) for s in starts],
                    {"requestedTime": None},
                )
            return respond(
                "answer",
                f"{stale}This doctor has no free times in the coming week. You could choose "
                "another doctor, or ask for another kind of doctor.",
                [Card(type="link", target="my_doctors")],
                {"bookingDoctorId": None, "requestedTime": None},
            )

        intent = current.intent
        if current.pendingChoice is not None and not used:
            # Step 6: one question, with the kinds of doctor that fit, or any kind.
            cards = [Card(type="choice", value=o) for o in current.pendingChoice.options]
            cards.append(Card(type="choice", value=ANY_DOCTOR_CHOICE))
            return respond(
                "clarify",
                "Different kinds of doctor see that. Which would you like? "
                "You can also choose any kind of doctor.",
                cards,
            )
        if intent in SEARCHING and current.bookingDoctorId:
            return booking_route()
        if intent in SEARCHING:
            narrowed = bool(
                crit.specialty
                or crit.areas
                or crit.doctorName
                or crit.language
                or crit.city
                or crit.consultationMode
            )
            # Step 6: with nothing to narrow it, a broad search is still useful (the care
            # team and soonest times come first); the reply invites more detail.
            wants_search = True
            if len(used) < MAX_TOOL_ROUNDS and not state.get("tool_failed"):
                if "getPatientCareTeam" not in used:
                    return tool("getPatientCareTeam", {})
                if wants_search and "searchDoctors" not in used:
                    args = {
                        k: v
                        for k, v in {
                            "specialty": crit.specialty,
                            "areas": list(crit.areas),
                            "city": crit.city,
                            "language": crit.language,
                            "mode": crit.consultationMode,
                            "name": crit.doctorName,
                            "excludeDoctorIds": list(current.excludedDoctorIds),
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
            if state.get("tool_failed") and state.get("tool_error") == "search_unavailable":
                # Search itself failed: not the same as nobody matching.
                return respond(
                    "fallback",
                    "Doctor search isn't available right now, so I can't suggest doctors. "
                    "You can still browse doctors in My Doctors, or try again in a few minutes.",
                    [Card(type="link", target="my_doctors")],
                )
            if state.get("tool_failed"):
                return respond(
                    "fallback",
                    "I couldn't finish looking that up. You can still find a doctor in My Doctors.",
                    [Card(type="link", target="my_doctors")],
                )
            parts: list[str] = []
            if current.specialtyFromConcern and crit.specialty in SPECIALTY_PHRASE:
                parts.append(SPECIALTY_PHRASE[crit.specialty])
            candidates = current.candidateDoctorIds
            summary = _criteria_summary(crit, ctx)
            if not candidates:
                # Genuinely nobody matches (the search worked): say what, and how to widen it.
                other = "another " if current.excludedDoctorIds else "a "
                found_text = f"I couldn't find {other}verified doctor {summary}".rstrip() + "."
                parts.append(f"{found_text} {_relax_hint(crit)}")
                return respond("answer", " ".join(parts), [Card(type="link", target="my_doctors")])
            if (
                intent == "book_appointment"
                and len(candidates) == 1
                and crit.doctorName
                and len(used) < MAX_TOOL_ROUNDS
            ):
                # "Book Dr. Meera": the one named doctor is the choice; go on to times.
                current = current.model_copy(update={"bookingDoctorId": candidates[0]})
                return booking_route()
            one = len(candidates) == 1
            parts.append(
                f"Here {'is' if one else 'are'} "
                f"{_plural(len(candidates), 'verified doctor', 'verified doctors')}"
                + (f" {summary}." if summary else ".")
                + (
                    ""
                    if one
                    else f" They're in the order I'd suggest for "
                    f"{'them' if ctx.actingFor == 'dependent' else 'you'}; each card says why."
                )
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
            if not narrowed:
                parts.append(
                    "Tell me the kind of doctor, what it's about, a city or a language to "
                    "narrow this down."
                )
            if intent == "book_appointment":
                parts.append("Tap Book on a doctor and I'll find a time with them.")
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
    graph.add_node("select", node_select)
    graph.add_conditional_edges(
        START, start, {"observe": "observe", "safety": "safety", "select": "select"}
    )
    graph.add_edge("select", "route")
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
