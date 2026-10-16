"""Step 6: conversational clarification, corrections and refinements (deterministic).

Each test plays several turns the way the backend does: the structured state from one
turn is sent with the next message, tools return canned results, and nothing else is
remembered. The fake model is rule-based; these tests check the validation, state and
routing logic around it, not language understanding.
"""

import uuid

from fastapi.testclient import TestClient

from tests.test_care_assistant import TOOLS, app_with, run_turn

DOC_A, DOC_B, DOC_C = (str(uuid.uuid4()) for _ in range(3))
READ_ONLY = {
    "getPatientContext",
    "getPatientCareTeam",
    "searchDoctors",
    "getDoctorProfile",
    "findAvailableSlots",
}


def recording_tools():
    """Canned tools that record every search's arguments; excluded doctors are honoured."""
    searches: list[dict] = []

    def search(args):
        searches.append(args)
        excluded = set(args.get("excludeDoctorIds", []))
        pool = [d for d in (DOC_A, DOC_B, DOC_C) if d not in excluded][:2]
        return {
            "ok": True,
            "data": {
                "status": "ok" if pool else "no_match",
                "doctors": [{"doctorId": d, "inCareTeam": False} for d in pool],
            },
        }

    return {**TOOLS, "searchDoctors": search}, searches


def converse(client, messages, tools, state=None):
    """Plays turns in order, carrying the state; returns every body and tool list."""
    bodies, executed_all = [], []
    for message in messages:
        body, executed = run_turn(client, message, tools, state=state)
        assert set(executed) <= READ_ONLY
        bodies.append(body)
        executed_all.append(executed)
        state = body["state"]
    return bodies, executed_all


def test_an_ambiguous_concern_gets_one_question_with_choices_and_no_search():
    app, _, _ = app_with()
    tools, searches = recording_tools()
    with TestClient(app) as client:
        (body,), (executed,) = converse(client, ["My child keeps getting headaches"], tools)
    assert body["reply"]["kind"] == "clarify"
    assert [c["value"] for c in body["reply"]["cards"]] == [
        "Paediatrics",
        "Neurology",
        "Any kind of doctor is fine",
    ]
    assert all(c["type"] == "choice" for c in body["reply"]["cards"])
    assert body["state"]["pendingChoice"] == {
        "kind": "specialty",
        "options": ["Paediatrics", "Neurology"],
    }
    assert body["state"]["clarifyTurns"] == 1
    assert searches == [] and "searchDoctors" not in executed


def test_answering_the_question_keeps_earlier_criteria_and_searches():
    app, _, _ = app_with()
    tools, searches = recording_tools()
    with TestClient(app) as client:
        bodies, _ = converse(
            client,
            ["My child keeps getting headaches, in Pune, online", "Paediatrics"],
            tools,
        )
    last = bodies[-1]["state"]
    assert last["pendingChoice"] is None and last["clarifyTurns"] == 0
    assert last["criteria"]["specialty"] == "Paediatrics"
    assert last["criteria"]["city"] == "Pune"
    assert last["criteria"]["consultationMode"] == "online"
    assert searches == [{"specialty": "Paediatrics", "city": "Pune", "mode": "online"}]


def test_any_kind_of_doctor_answers_the_question_with_a_broad_search():
    app, _, _ = app_with()
    tools, searches = recording_tools()
    with TestClient(app) as client:
        bodies, _ = converse(client, ["I have stomach pain", "Any kind of doctor is fine"], tools)
    last = bodies[-1]["state"]
    assert last["criteria"]["specialty"] is None
    assert "specialty" in last["removed"]
    assert last["pendingChoice"] is None
    assert searches == [{}]


def test_repeated_ambiguity_never_loops():
    app, _, _ = app_with()
    tools, searches = recording_tools()
    with TestClient(app) as client:
        bodies, _ = converse(
            client,
            ["I have stomach pain", "my stomach still hurts", "stomach ache again"],
            tools,
        )
    kinds = [b["reply"]["kind"] for b in bodies]
    assert kinds == ["clarify", "clarify", "answer"]  # at most two questions in a row
    assert len(searches) == 1


def test_a_clear_request_is_not_questioned():
    app, _, _ = app_with()
    tools, searches = recording_tools()
    with TestClient(app) as client:
        (body,), _ = converse(client, ["I need a dermatologist"], tools)
    assert body["reply"]["kind"] == "answer"
    assert body["state"]["pendingChoice"] is None
    assert searches == [{"specialty": "Dermatology"}]


def test_corrections_replace_the_old_specialty_and_drop_what_no_longer_fits():
    app, _, _ = app_with()
    tools, _ = recording_tools()
    with TestClient(app) as client:
        bodies, _ = converse(
            client,
            ["A skin doctor for pimples", "Actually, I want a cardiologist"],
            tools,
        )
        assert bodies[0]["state"]["criteria"]["areas"] == ["acne"]
        last = bodies[-1]["state"]["criteria"]
        assert last["specialty"] == "Cardiology" and last["areas"] == []
        bodies, _ = converse(client, ["A skin doctor for pimples", "Any specialty is okay"], tools)
    last = bodies[-1]["state"]
    assert last["criteria"]["specialty"] is None and last["criteria"]["areas"] == []
    assert set(last["removed"]) >= {"specialty", "areas"}


def test_removing_city_language_or_mode_removes_the_filter():
    app, _, _ = app_with()
    tools, searches = recording_tools()
    start = "A dermatologist in Delhi who speaks Hindi, online"
    with TestClient(app) as client:
        for follow_up, gone in [
            ("Anywhere is fine", "city"),
            ("Any language is fine", "language"),
            ("Online or in person is fine", "consultationMode"),
        ]:
            searches.clear()
            bodies, _ = converse(client, [start, follow_up], tools)
            crit = bodies[-1]["state"]["criteria"]
            assert crit[gone] is None, follow_up
            assert gone in bodies[-1]["state"]["removed"]
            arg = {"consultationMode": "mode"}.get(gone, gone)
            assert arg not in searches[-1]
            # Everything else is kept.
            assert crit["specialty"] == "Dermatology"


def test_anywhere_in_a_city_keeps_the_city():
    app, _, _ = app_with()
    tools, _ = recording_tools()
    with TestClient(app) as client:
        (body,), _ = converse(client, ["A dermatologist, anywhere in Delhi"], tools)
    assert body["state"]["criteria"]["city"] == "Delhi"
    assert body["state"]["removed"] == []


def test_unsupported_preferences_are_answered_honestly_not_filtered():
    app, _, _ = app_with()
    tools, searches = recording_tools()
    with TestClient(app) as client:
        (body,), _ = converse(client, ["I want a female doctor, a dermatologist please"], tools)
    assert body["reply"]["message"].startswith(
        "I can't choose doctors by gender: HealthBridge doesn't record it."
    )
    assert searches == [{"specialty": "Dermatology"}]
    assert body["state"]["notices"] == ["gender"]


def test_show_me_others_hides_the_doctors_already_shown():
    app, _, _ = app_with()
    tools, searches = recording_tools()
    with TestClient(app) as client:
        bodies, _ = converse(
            client, ["I need a dermatologist", "Not this doctor, show me other options"], tools
        )
    assert bodies[0]["state"]["candidateDoctorIds"] == [DOC_A, DOC_B]
    assert set(bodies[-1]["state"]["excludedDoctorIds"]) == {DOC_A, DOC_B}
    assert searches[-1]["excludeDoctorIds"] == [DOC_A, DOC_B]
    assert bodies[-1]["state"]["candidateDoctorIds"] == [DOC_C]


def test_a_new_session_starts_with_no_old_criteria():
    app, _, _ = app_with()
    tools, searches = recording_tools()
    with TestClient(app) as client:
        converse(client, ["A cardiologist in Pune who speaks Hindi"], tools)
        # A new session: the backend sends an empty state.
        (body,), _ = converse(client, ["I need a dermatologist"], tools)
    assert body["state"]["criteria"]["city"] is None
    assert body["state"]["criteria"]["language"] is None
    assert searches[-1] == {"specialty": "Dermatology"}


def test_malformed_clarification_fields_are_dropped():
    app, _, _ = app_with(
        {
            "care_assistant_intent": lambda _r: {
                "intent": "find_doctor",
                "specialty": None,
                "specialtyFromConcern": False,
                "dayKind": "none",
                "timeWindow": None,
                "specialtyOptions": ["Astrology", 7, "Dermatology"],
                "remove": ["everything", "city"],
                "showOthers": "yes",
                "unsupported": ["horoscope", "gender"],
            }
        }
    )
    tools, searches = recording_tools()
    with TestClient(app) as client:
        (body,), _ = converse(client, ["a woman doctor please"], tools)
    state = body["state"]
    assert state["pendingChoice"] is None  # one valid option is not a choice
    assert state["removed"] == ["city"]
    assert state["excludedDoctorIds"] == []
    assert state["notices"] == ["gender"]
    assert searches == [{}]


def test_emergency_wording_still_wins_over_a_question():
    app, _, llm = app_with()
    tools, searches = recording_tools()
    with TestClient(app) as client:
        (body,), (executed,) = converse(client, ["My child has headaches and a seizure"], tools)
    assert body["reply"]["kind"] == "emergency"
    assert executed == [] and searches == [] and llm.calls == []


def scripted(**overrides):
    """The offline planner's form, with fields a small model got wrong."""
    from app.llm.care_fake import care_assistant_intent

    return {"care_assistant_intent": lambda r: {**care_assistant_intent(r), **overrides}}


def test_preferences_the_message_never_mentions_are_not_answered():
    every = ["gender", "age", "fees", "ratings", "insurance", "other"]
    app, _, _ = app_with(scripted(unsupported=every))
    tools, _ = recording_tools()
    with TestClient(app) as client:
        (body,), _ = converse(
            client, ["I need a doctor for my diabetes, online, tomorrow morning"], tools
        )
        assert body["state"]["notices"] == []
        assert "I can't" not in body["reply"]["message"]
        (body,), _ = converse(client, ["A cheap female doctor for my diabetes"], tools)
        assert body["state"]["notices"] == ["gender", "fees"]


def test_a_question_about_ones_own_results_is_a_records_question():
    app, _, _ = app_with(scripted(intent="book_appointment"))
    tools, _ = recording_tools()
    cases = [
        ("What did my last HbA1c report say?", "ask_records"),
        ("How has my sugar changed?", "ask_records"),
        ("Can you summarise my echo report?", "ask_records"),
        ("Book a doctor to go over my reports", "book_appointment"),
        ("My sugar is high", "book_appointment"),
        ("Which tests should I get?", "book_appointment"),
    ]
    with TestClient(app) as client:
        for message, intent in cases:
            (body,), _ = converse(client, [message], tools)
            assert body["state"]["intent"] == intent, message
