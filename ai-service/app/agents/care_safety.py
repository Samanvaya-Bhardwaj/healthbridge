"""Deterministic safety check for the care assistant (no model involved).

Wording that can signal an emergency is answered with fixed guidance (call 112 or 108)
before any model runs. This is not triage: it only stops the assistant from treating a
possible emergency as a booking request. Clinical urgency stays with the existing
rule-based follow-up escalation and the doctor's outcome.
"""

import re

_EMERGENCY = re.compile(
    r"\b("
    r"chest pain|pain in (my|the) chest|"
    r"(can'?t|cannot|can not|unable to|difficulty|trouble|struggling to) breath(e|ing)?|"
    r"short(ness)? of breath|not breathing|"
    r"unconscious|passed out|fainted|collapsed|"
    r"seizure|convulsion|having a fit|"
    r"stroke|face (is )?drooping|slurred speech|"
    r"(severe|heavy|uncontrolled) bleeding|bleeding (heavily|a lot|won'?t stop)|"
    r"suicid\w*|kill myself|end my life|self[- ]harm|"
    r"overdose|poison(ed|ing)?"
    r")\b",
    re.I,
)

EMERGENCY_MESSAGE = (
    "If this might be an emergency, call 112 or 108 now, or go to the nearest emergency "
    "department. Don't wait for an online consultation."
)


def is_possible_emergency(text: str) -> bool:
    return bool(_EMERGENCY.search(text))
