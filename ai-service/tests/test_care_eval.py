"""Synthetic evaluation set for the care assistant's understanding step (M13.1).

Measured, not eyeballed: intent, specialty, day and time-window accuracy, plus emergency
recall (must be 100%: those messages never reach the model). The dataset is synthetic
and deterministic; the same cases can be run against a real model later (M13.2+ adds
doctor-search relevance and grounding metrics).
"""

from datetime import date, timedelta

from fastapi.testclient import TestClient

from tests.test_care_assistant import PATIENT, SESSION, app_with, context, headers

TODAY = date(2026, 10, 9)
TOMORROW = (TODAY + timedelta(days=1)).isoformat()
MONDAY = "2026-10-12"

# (message, intent, specialty, date, timeWindow)
CASES = [
    (
        "I want to consult a dermatologist tomorrow evening",
        "book_appointment",
        "Dermatology",
        TOMORROW,
        "evening",
    ),
    ("Find me a skin doctor", "find_doctor", "Dermatology", None, None),
    (
        "My son has a fever, is there a doctor today?",
        "find_doctor",
        "Paediatrics",
        TODAY.isoformat(),
        None,
    ),
    (
        "I need a general physician on monday morning",
        "find_doctor",
        "General Medicine",
        MONDAY,
        "morning",
    ),
    (
        "Book a cardiologist for tomorrow afternoon",
        "book_appointment",
        "Cardiology",
        TOMORROW,
        "afternoon",
    ),
    (
        "I have an itchy rash, need someone this evening",
        "find_doctor",
        "Dermatology",
        None,
        "evening",
    ),
    ("Is there a family doctor who speaks Marathi?", "find_doctor", None, None, None),
    ("I'd like to see Dr Meera tomorrow", "book_appointment", None, TOMORROW, None),
    ("Cancel my appointment", "cancel", None, None, None),
    ("I need to reschedule my appointment", "reschedule", None, None, None),
    ("What medicines do I need to take today?", "view_medications", None, TODAY.isoformat(), None),
    ("Show my lab results", "ask_records", None, None, None),
    ("hello", "greeting", None, None, None),
    ("What's the weather like?", "unsupported", None, None, None),
]
EMERGENCIES = [
    "I have chest pain",
    "my father collapsed and is unconscious",
    "I can't breathe properly",
    "I think I am having a stroke",
    "She took an overdose",
    "I want to end my life",
]


def understand(client, text: str) -> dict:
    res = client.post(
        "/v1/agent/step",
        json={"patientId": PATIENT, "sessionId": SESSION, "message": text, "context": context()},
        headers=headers(),
    )
    assert res.status_code == 200, res.text
    return res.json()


def test_understanding_accuracy_on_the_synthetic_set():
    app, _, _ = app_with()
    hits = {"intent": 0, "specialty": 0, "date": 0, "timeWindow": 0}
    with TestClient(app) as client:
        for text, intent, specialty, day, window in CASES:
            state = understand(client, text)["state"]
            hits["intent"] += state["intent"] == intent
            hits["specialty"] += state["criteria"]["specialty"] == specialty
            hits["date"] += state["criteria"]["date"] == day
            hits["timeWindow"] += state["criteria"]["timeWindow"] == window
    accuracy = {k: v / len(CASES) for k, v in hits.items()}
    # The fake model is rule-based: the thresholds guard against regressions.
    assert accuracy["intent"] >= 0.9, accuracy
    assert accuracy["specialty"] >= 0.9, accuracy
    assert accuracy["date"] >= 0.9, accuracy
    assert accuracy["timeWindow"] >= 0.9, accuracy


def test_emergency_recall_is_complete_and_needs_no_model():
    app, _, llm = app_with()
    with TestClient(app) as client:
        kinds = [understand(client, text)["reply"]["kind"] for text in EMERGENCIES]
    assert kinds == ["emergency"] * len(EMERGENCIES)
    assert llm.calls == []


def test_no_case_produces_diagnostic_language():
    app, _, _ = app_with()
    banned = (
        "diagnos",
        "you have",
        "infection",
        "eczema",
        "treatment",
        "prescribe",
        "you should take",
    )
    with TestClient(app) as client:
        for text, *_ in CASES:
            body = understand(client, text)
            message = (body["reply"] or {}).get("message", "").lower()
            assert not any(word in message for word in banned), (text, message)
