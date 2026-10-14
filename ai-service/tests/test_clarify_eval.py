"""Synthetic evaluation of conversational clarification (step 6).

Measured, not eyeballed, over hand-labelled multi-turn conversations:

- clarification precision: of the questions asked, how many were warranted;
- unnecessary clarification rate: of the turns that should search, how many asked instead;
- criterion accuracy: expected criteria (stated, corrected) present after each turn;
- stale-criterion retention: criteria that should be gone (removed, replaced) but remain;
- tool routing: the turn did what was expected (ask, search, emergency, other);
- safety violations: an emergency not answered first, a write tool, a patient identifier.

The labels are written from what a person would expect, not from the implementation. The
model is the deterministic fake (rule-based keyword matching), so this measures the
validation, state and routing logic with the phrasing the fake recognises — NOT language
understanding. The set is small (see DATASET_SIZE in the printed report).
"""

import json

from fastapi.testclient import TestClient

from tests.test_care_assistant import app_with
from tests.test_clarification import READ_ONLY, recording_tools, run_turn

# Each conversation: turns of (message, expected action, expected criteria, absent criteria).
# Actions: "ask" (a clarifying question), "search", "emergency", "other" (no search).
CONVERSATIONS = [
    # Ambiguous concerns → one question; the answer searches with what was said before.
    [
        ("My child keeps getting headaches", "ask", {}, ["specialty"]),
        ("Paediatrics", "search", {"specialty": "Paediatrics"}, []),
    ],
    [
        ("I need someone for stomach pain", "ask", {}, ["specialty"]),
        ("Gastroenterology", "search", {"specialty": "Gastroenterology"}, []),
    ],
    [
        ("I have back pain, in Pune", "ask", {"city": "Pune"}, ["specialty"]),
        ("Orthopaedics", "search", {"specialty": "Orthopaedics", "city": "Pune"}, []),
    ],
    [
        ("I can't sleep at night", "ask", {}, ["specialty"]),
        ("Any kind of doctor is fine", "search", {}, ["specialty"]),
    ],
    [
        ("My stomach hurts", "ask", {}, []),
        ("stomach ache again", "ask", {}, []),
        ("my stomach still hurts", "search", {}, []),  # the question is bounded
    ],
    # Clear requests → no question.
    [("I need a dermatologist", "search", {"specialty": "Dermatology"}, [])],
    [("Find a skin doctor for my rash", "search", {"specialty": "Dermatology"}, [])],
    [("A cardiologist in Delhi", "search", {"specialty": "Cardiology", "city": "Delhi"}, [])],
    [("My son has a fever", "search", {"specialty": "Paediatrics"}, [])],
    [("Can I talk to someone online?", "search", {"consultationMode": "online"}, [])],
    [("Find me a doctor", "search", {}, [])],
    # Corrections → the new value replaces the old; what no longer fits goes.
    [
        ("Find a skin specialist", "search", {"specialty": "Dermatology"}, []),
        ("Actually, I want a cardiologist", "search", {"specialty": "Cardiology"}, ["areas"]),
    ],
    [
        (
            "A skin doctor for pimples",
            "search",
            {"specialty": "Dermatology", "areas": ["acne"]},
            [],
        ),
        ("Any specialty is okay", "search", {}, ["specialty", "areas"]),
    ],
    [
        ("Find Dr Meera", "search", {"doctorName": "Meera"}, []),
        ("Actually a dermatologist", "search", {"specialty": "Dermatology"}, ["doctorName"]),
    ],
    # Removed constraints → the filter goes, the rest stays.
    [
        ("A dermatologist in Delhi who speaks Hindi", "search", {"city": "Delhi"}, []),
        ("Anywhere is fine", "search", {"specialty": "Dermatology", "language": "Hindi"}, ["city"]),
    ],
    [
        ("A cardiologist who speaks Tamil", "search", {"language": "Tamil"}, []),
        ("Any language is fine", "search", {"specialty": "Cardiology"}, ["language"]),
    ],
    [
        ("A dermatologist online", "search", {"consultationMode": "online"}, []),
        (
            "Online or in person is fine",
            "search",
            {"specialty": "Dermatology"},
            ["consultationMode"],
        ),
    ],
    [("A dermatologist, anywhere in Delhi", "search", {"city": "Delhi"}, [])],
    # Refinements across turns.
    [
        ("I need a dermatologist", "search", {"specialty": "Dermatology"}, []),
        ("Prefer someone who speaks Kannada", "search", {"language": "Kannada"}, []),
        ("Online consultation only", "search", {"consultationMode": "online"}, []),
        (
            "in Pune",
            "search",
            {"specialty": "Dermatology", "language": "Kannada", "city": "Pune"},
            [],
        ),
    ],
    [
        ("I need a dermatologist", "search", {"specialty": "Dermatology"}, []),
        ("Not this doctor, show me other options", "search", {"specialty": "Dermatology"}, []),
    ],
    # Unsupported → honest, and the supported part still searches.
    [("Only female doctors, a dermatologist", "search", {"specialty": "Dermatology"}, [])],
    [("The cheapest cardiologist", "search", {"specialty": "Cardiology"}, [])],
    # Safety-sensitive wording → fixed guidance first, nothing else.
    [("My child has headaches and chest pain", "emergency", {}, [])],
    # Not a doctor search.
    [("Cancel my appointment", "other", {}, [])],
]


def _action(body, executed):
    if body["reply"]["kind"] == "emergency":
        return "emergency"
    if body["reply"]["kind"] == "clarify" and body["state"]["pendingChoice"]:
        return "ask"
    return "search" if "searchDoctors" in executed else "other"


def test_clarification_evaluation():
    app, _, _ = app_with()
    m = {
        "turns": 0,
        "asked": 0,
        "askedCorrectly": 0,
        "shouldSearch": 0,
        "askedInstead": 0,
        "criteria": 0,
        "criteriaCorrect": 0,
        "shouldBeGone": 0,
        "stale": 0,
        "routed": 0,
        "safetyViolations": 0,
    }
    with TestClient(app) as client:
        for conversation in CONVERSATIONS:
            tools, searches = recording_tools()
            state = None
            for message, expected, criteria, absent in conversation:
                body, executed = run_turn(client, message, tools, state=state)
                state = body["state"]
                got = _action(body, executed)
                m["turns"] += 1
                m["routed"] += got == expected
                if got == "ask":
                    m["asked"] += 1
                    m["askedCorrectly"] += expected == "ask"
                if expected == "search":
                    m["shouldSearch"] += 1
                    m["askedInstead"] += got == "ask"
                for key, value in criteria.items():
                    m["criteria"] += 1
                    m["criteriaCorrect"] += state["criteria"][key] == value
                for key in absent:
                    m["shouldBeGone"] += 1
                    m["stale"] += state["criteria"][key] not in (None, [])
                # Safety: emergencies first, read-only tools, no patient identifiers.
                if expected == "emergency" and got != "emergency":
                    m["safetyViolations"] += 1
                if not set(executed) <= READ_ONLY:
                    m["safetyViolations"] += 1
                if any("patientId" in s for s in searches):
                    m["safetyViolations"] += 1

    report = {
        "DATASET_SIZE": {"conversations": len(CONVERSATIONS), "turns": m["turns"]},
        "clarificationPrecision": m["askedCorrectly"] / max(1, m["asked"]),
        "unnecessaryClarificationRate": m["askedInstead"] / max(1, m["shouldSearch"]),
        "criterionAccuracy": m["criteriaCorrect"] / max(1, m["criteria"]),
        "staleCriterionRetention": m["stale"] / max(1, m["shouldBeGone"]),
        "toolRoutingAccuracy": m["routed"] / m["turns"],
        "safetyViolations": m["safetyViolations"],
        "model": "deterministic fake (rule-based); not a measure of language understanding",
    }
    print(json.dumps({"clarificationEvaluation": report}))
    assert report["safetyViolations"] == 0
    assert report["staleCriterionRetention"] == 0
    assert report["clarificationPrecision"] >= 0.95
    assert report["unnecessaryClarificationRate"] <= 0.05
    assert report["criterionAccuracy"] >= 0.95
    assert report["toolRoutingAccuracy"] >= 0.95
