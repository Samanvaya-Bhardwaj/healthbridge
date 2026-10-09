"""Deterministic stand-in for the care assistant's intent form (fake provider).

Keyword rules over the delimited message, returning the same JSON form a real model
returns, so the same validation and routing apply. It is not intelligent: it recognises
the phrasing used by the synthetic demo and tests.
"""

import re
from typing import Any

from app.llm.base import LLMRequest

_MESSAGE = re.compile(r"<message>\n?(.*?)\n?</message>", re.S)
_ALLOWED = re.compile(r"^Allowed specialties: (.*)$", re.M)

_NAMED = [
    (r"dermatolog", "Dermatology"),
    (r"p(a)?ediatric", "Paediatrics"),
    (r"gyn(a)?ecolog", "Gynaecology"),
    (r"cardiolog", "Cardiology"),
    (r"orthop(a)?edic", "Orthopaedics"),
    (r"\bent\b|ear,? nose", "ENT"),
    (r"ophthalmolog|eye doctor", "Ophthalmology"),
    (r"psychiatr", "Psychiatry"),
    (r"neurolog", "Neurology"),
    (r"gastroenterolog", "Gastroenterology"),
    (r"endocrinolog", "Endocrinology"),
    (r"pulmonolog", "Pulmonology"),
    (r"general physician|general medicine|\bgp\b", "General Medicine"),
    (r"family doctor|family medicine", "Family Medicine"),
]
_CONCERN = [
    (r"skin|rash|itch|acne|eczema|irritation", "Dermatology"),
    (r"\b(child|son|daughter|baby|kid)s?\b", "Paediatrics"),
    (r"\beyes?\b|vision", "Ophthalmology"),
    (r"\bears?\b|throat|sinus|\bnose\b", "ENT"),
    (r"joint|knee|back pain|\bbones?\b", "Orthopaedics"),
    (r"stomach|digestion|acidity", "Gastroenterology"),
    (r"thyroid|diabet", "Endocrinology"),
    (r"anxiety|depress|stress|can'?t sleep", "Psychiatry"),
    (r"headache|migraine", "Neurology"),
    (r"fever|cough|\bcold\b|\bflu\b", "General Medicine"),
]
_LANGUAGES = [
    "Hindi",
    "English",
    "Marathi",
    "Tamil",
    "Telugu",
    "Kannada",
    "Malayalam",
    "Bengali",
    "Gujarati",
    "Urdu",
    "Punjabi",
]
_CITIES = ["Pune", "Mumbai", "Delhi", "Bengaluru", "Bangalore", "Chennai", "Hyderabad", "Kolkata"]
_WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]


def _intent(text: str, has_specialty: bool) -> str:
    t = text.lower()
    if re.fullmatch(r"\s*(hi|hello|hey|namaste|good (morning|evening))[!. ]*", t):
        return "greeting"
    if re.search(r"reschedul|move my appointment|change my appointment", t):
        return "reschedule"
    if re.search(r"\bcancel", t):
        return "cancel"
    if re.search(r"medicine|medication|tablets?|pills?", t):
        return "view_medications"
    if re.search(r"my (records?|reports?|results?)|lab (report|result)", t):
        return "ask_records"
    if re.search(r"(my|upcoming|next) appointments?", t) and not re.search(r"\bbook\b", t):
        return "view_appointments"
    if re.search(r"\bbook|appointment|consult|\bsee (a|my|the|dr)\b|schedule", t):
        return "book_appointment"
    if has_specialty or re.search(r"doctor|specialist|\bdr\b|physician", t):
        return "find_doctor"
    return "unsupported"


def care_assistant_intent(request: LLMRequest) -> dict[str, Any]:
    content = request.messages[-1].content
    match = _MESSAGE.search(content)
    text = match.group(1) if match else ""
    low = text.lower()
    allowed_line = _ALLOWED.search(content)
    allowed = {s.strip() for s in allowed_line.group(1).split(",")} if allowed_line else set()

    specialty, from_concern = None, False
    for pattern, name in _NAMED:
        if re.search(pattern, low) and name in allowed:
            specialty = name
            break
    if specialty is None:
        for pattern, name in _CONCERN:
            if re.search(pattern, low) and name in allowed:
                specialty, from_concern = name, True
                break

    day_kind, weekday, iso = "none", None, None
    if re.search(r"\btoday\b|\btonight\b", low):
        day_kind = "today"
    elif "tomorrow" in low:
        day_kind = "tomorrow"
    elif found := re.search(r"\b(\d{4}-\d{2}-\d{2})\b", low):
        day_kind, iso = "date", found.group(1)
    else:
        for day in _WEEKDAYS:
            if re.search(rf"\b{day}\b", low):
                day_kind, weekday = "weekday", day
                break

    window = None
    if "morning" in low:
        window = "morning"
    elif "afternoon" in low:
        window = "afternoon"
    elif re.search(r"evening|tonight|after work", low):
        window = "evening"

    mode = None
    if re.search(r"\bonline\b|video|from home", low):
        mode = "online"
    elif re.search(r"in[- ]clinic|in person|in-person|at the clinic", low):
        mode = "in_clinic"

    language = next((lang for lang in _LANGUAGES if re.search(rf"\b{lang.lower()}\b", low)), None)
    city = next((c for c in _CITIES if re.search(rf"\bin {c.lower()}\b", low)), None)
    name = re.search(r"\b(?:Dr\.?|Doctor)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)", text)

    return {
        "intent": _intent(text, specialty is not None or name is not None),
        "specialty": specialty,
        "specialtyFromConcern": from_concern,
        "consultationMode": mode,
        "dayKind": day_kind,
        "weekday": weekday,
        "date": iso,
        "timeWindow": window,
        "language": language,
        "city": city,
        "doctorName": name.group(1) if name else None,
    }
