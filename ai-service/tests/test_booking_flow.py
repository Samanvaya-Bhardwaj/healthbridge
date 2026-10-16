"""Booking in the conversation (ADR-0038): choose a doctor, pick a time, confirm.

The assistant proposes; only the person's Confirm (a backend endpoint) books. Taps on
offered doctors and times are applied by code with no model call.
"""

import uuid

from fastapi.testclient import TestClient

from tests.test_care_assistant import (
    DERM_IN_TEAM,
    DERM_NEW,
    PATIENT,
    SESSION,
    TOOLS,
    app_with,
    context,
    digest,
    headers,
)

SLOT_A = "2026-10-12T05:00:00Z"  # 10:30 India time (UTC+5:30)
SLOT_B = "2026-10-12T05:30:00Z"  # 11:00


def ctx() -> dict:
    return {**context(), "utcOffsetMinutes": 330}


def slots_tool(args: dict) -> dict:
    if args.get("date") == "2026-10-13":
        return {"ok": True, "data": {"doctorId": args["doctorId"], "slots": []}}
    return {
        "ok": True,
        "data": {
            "doctorId": args["doctorId"],
            "slots": [
                {"startsAt": SLOT_A, "mode": "online"},
                {"startsAt": SLOT_B, "mode": "online"},
            ],
        },
    }


TOOLS_B = {**TOOLS, "findAvailableSlots": slots_tool}


def turn(client, text: str, state: dict, selection: dict | None = None, tools=TOOLS_B):
    """Plays the backend: one message (or tap), then the tools the steps ask for."""
    body = {
        "patientId": PATIENT,
        "sessionId": SESSION,
        "message": text,
        "inputDigest": digest(text),
        "state": state,
        "context": ctx(),
    }
    if selection:
        body["selection"] = selection
    res = client.post("/v1/agent/step", json=body, headers=headers())
    assert res.status_code == 200, res.text
    out, executed = res.json(), []
    while out["action"]["type"] == "tool":
        name, args = out["action"]["tool"], out["action"]["args"]
        executed.append(name)
        res = client.post(
            "/v1/agent/step",
            json={
                "patientId": PATIENT,
                "sessionId": SESSION,
                "state": out["state"],
                "toolResult": {"name": name, **tools[name](args)},
                "toolsThisTurn": executed,
                "context": ctx(),
            },
            headers=headers(),
        )
        assert res.status_code == 200, res.text
        out = res.json()
        assert len(executed) <= 3
    return out, executed


SHOWN = {"intent": "find_doctor", "candidateDoctorIds": [DERM_IN_TEAM, DERM_NEW]}


def test_tapping_a_doctor_then_a_time_proposes_without_any_model_call() -> None:
    app, _, llm = app_with()
    with TestClient(app) as client:
        out, executed = turn(
            client, "Book with this doctor", SHOWN, {"kind": "doctor", "doctorId": DERM_NEW}
        )
        assert executed == ["findAvailableSlots"]
        assert out["reply"]["kind"] == "clarify"
        assert [c["startsAt"] for c in out["reply"]["cards"]] == [SLOT_A, SLOT_B]
        assert out["state"]["bookingDoctorId"] == DERM_NEW

        out, executed = turn(
            client,
            "Monday 10:30",
            out["state"],
            {"kind": "slot", "doctorId": DERM_NEW, "startsAt": SLOT_A},
        )
        assert executed == []
        assert out["reply"]["kind"] == "confirm"
        assert out["reply"]["cards"] == [
            {"type": "booking", "doctorId": DERM_NEW, "startsAt": SLOT_A}
        ]
    assert llm.calls == []  # taps never reach the model


def test_a_tap_on_something_not_offered_is_refused() -> None:
    app, _, llm = app_with()
    stranger = str(uuid.uuid4())
    with TestClient(app) as client:
        out, _ = turn(client, "Book", SHOWN, {"kind": "doctor", "doctorId": stranger})
        assert out["state"]["bookingDoctorId"] is None
        assert all(c["type"] != "booking" for c in out["reply"]["cards"])
        # A time that was never offered for this doctor proposes nothing either.
        state = {
            **SHOWN,
            "bookingDoctorId": DERM_NEW,
            "selectedDoctorId": DERM_NEW,
            "slotStarts": [SLOT_A],
        }
        out, _ = turn(
            client, "11:00", state, {"kind": "slot", "doctorId": DERM_NEW, "startsAt": SLOT_B}
        )
        assert out["reply"]["kind"] != "confirm"
        assert "isn't available any more" in out["reply"]["message"]
    assert llm.calls == []


def test_words_choose_a_doctor_by_position_and_a_time_by_the_clock() -> None:
    app, _, _ = app_with()
    with TestClient(app) as client:
        out, executed = turn(client, "book the second one", SHOWN)
        assert out["state"]["bookingDoctorId"] == DERM_NEW
        assert "findAvailableSlots" in executed
        out, _ = turn(client, "at 10:30 please", out["state"])
        assert out["reply"]["kind"] == "confirm"
        assert out["reply"]["cards"][0]["startsAt"] == SLOT_A
        # A time that is not free: the offered times again, saying so.
        out2, _ = turn(client, "at 4 pm", {**out["state"], "chosenStart": None})
        assert out2["reply"]["kind"] == "clarify"
        assert "16:00 isn't free" in out2["reply"]["message"]


def test_a_day_without_free_times_offers_the_next_ones() -> None:
    app, _, _ = app_with()
    state = {**SHOWN, "bookingDoctorId": DERM_IN_TEAM}
    with TestClient(app) as client:
        out, executed = turn(client, "on 2026-10-13 please", state)
    assert executed == ["findAvailableSlots", "findAvailableSlots"]
    assert out["reply"]["kind"] == "clarify"
    assert "no free times" in out["reply"]["message"]
    assert len(out["reply"]["cards"]) == 2


def test_a_plain_yes_shows_the_same_proposal_again() -> None:
    app, _, _ = app_with()
    state = {
        **SHOWN,
        "intent": "book_appointment",
        "bookingDoctorId": DERM_NEW,
        "selectedDoctorId": DERM_NEW,
        "slotStarts": [SLOT_A, SLOT_B],
        "chosenStart": SLOT_B,
    }
    with TestClient(app) as client:
        out, _ = turn(client, "yes book it", state)
    assert out["reply"]["kind"] == "confirm"
    assert out["reply"]["cards"][0]["startsAt"] == SLOT_B
