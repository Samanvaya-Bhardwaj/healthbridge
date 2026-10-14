"""Deterministic safety check for the care assistant (no model involved).

Wording that can signal an emergency is answered with fixed guidance (call 112 or 108)
before any model runs. This is not triage: it only stops the assistant from treating a
possible emergency as a booking request. Clinical urgency stays with the existing
rule-based follow-up escalation and the doctor's outcome.
"""

import re
import unicodedata

_EMERGENCY = re.compile(
    r"\b("
    r"chest pain|pain in (my|the) chest|"
    r"(can'?t|cannot|can not|unable to|difficulty|trouble|struggling to) breath(e|ing)?|"
    r"short(ness)? of breath|not breathing|"
    r"unconscious|passed out|fainted|collapsed|"
    r"seizures?|convulsions?|having a fit|"
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


# Matching normalisation, mirrored exactly by @healthbridge/shared (a backend test checks
# both the constants and shared test cases): apostrophe look-alikes people type (curly
# quotes, modifier letter, prime, backtick, acute, fullwidth) become "'", dash look-alikes
# (hyphens, en and em dashes, minus) become "-", then Unicode NFKC folds compatibility
# forms (fullwidth letters, no-break spaces), then any run of whitespace becomes one space.
APOSTROPHES = "\u2018\u2019\u201b\u02bc\u02b9\u2032\u0060\u00b4\uff07"
DASHES = "\u2010\u2011\u2012\u2013\u2014\u2015\u2212\ufe58\ufe63\uff0d"
WHITESPACE = " \t\n\r\f\v\u0085\u2028\u2029"
_CHARACTER_MAP = {ord(c): "'" for c in APOSTROPHES} | {ord(c): "-" for c in DASHES}
_SPACES = re.compile("[" + WHITESPACE + "]+")


def normalize_for_screening(text: str) -> str:
    folded = unicodedata.normalize("NFKC", text.translate(_CHARACTER_MAP))
    return _SPACES.sub(" ", folded)


def is_possible_emergency(text: str) -> bool:
    return bool(_EMERGENCY.search(normalize_for_screening(text)))
