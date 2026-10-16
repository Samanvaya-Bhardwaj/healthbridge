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
_ALLOWED_AREAS = re.compile(r"^Allowed areas of practice: (.*)$", re.M)

# M13.2: wording that fits an area of practice (the validator keeps only areas that fit
# the specialty, so a few candidates per message is fine).
_AREAS = [
    (r"pimple|acne|breakout", "acne"),
    (r"eczema|dermatitis", "eczema"),
    (r"psoriasis", "psoriasis"),
    (r"hair ?(fall|loss)|losing (my )?hair|bald", "hair_loss"),
    (r"rash|hives|itch|skin allerg", "skin_allergies"),
    (r"pigment|dark spots", "pigmentation"),
    (r"diabet|blood sugar|sugar level", "diabetes"),
    (r"blood pressure|\bbp\b|hypertension", "blood_pressure"),
    (r"thyroid", "thyroid"),
    (r"asthma|wheez", "asthma"),
    (r"(long|persistent|lasting) cough|cough for (weeks|a month)", "long_cough"),
    (r"headache|migraine", "headache_migraine"),
    (r"anxiety|anxious|panic", "anxiety"),
    (r"depress|low mood", "depression"),
    (r"can'?t sleep|insomnia|sleep problem", "sleep"),
    (r"joint|knee", "joint_pain"),
    (r"back pain|neck pain", "back_neck_pain"),
    (r"sprain|sports injur", "sports_injuries"),
    (r"pregnan|expecting a baby", "pregnancy_care"),
    (r"\bperiods?\b|menstrua", "menstrual_health"),
    (r"pcos|pcod", "pcos"),
    (r"growth|development|milestone", "child_growth"),
    (r"vaccin|immuni[sz]", "vaccinations"),
    (r"acidity|heartburn|reflux", "acidity_reflux"),
    (r"stomach (pain|ache)|abdominal pain", "stomach_pain"),
    (r"glasses|blurry|vision", "vision"),
    (r"hearing|ear ?ache|ear pain", "ear_hearing"),
    (r"sinus", "sinus"),
    (r"cholesterol", "cholesterol"),
    (r"fever|infection", "fever_infections"),
    (r"fever|infection", "childhood_infections"),
]

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
# Step 6: concerns that more than one kind of doctor sees (ask which, if none named).
_AMBIGUOUS = [
    (
        r"\b(child|son|daughter|kid)s?\b.*(headache|migraine)|(headache|migraine).*\b(child|son|daughter|kid)s?\b",
        ["Paediatrics", "Neurology"],
    ),
    (r"stomach|abdominal|tummy", ["Gastroenterology", "General Medicine"]),
    (r"back pain|neck pain", ["Orthopaedics", "Neurology"]),
    (r"can'?t sleep|insomnia|sleep problem|trouble sleeping", ["Psychiatry", "Neurology"]),
]
# Step 6: "I don't mind ..." wording, per criterion.
_REMOVE = [
    (
        "|".join(
            [
                r"any (kind of |type of )?doctor",
                r"any (kind of )?speciali?t(y|ies)",
                r"no preference (for|on) (the )?speciali",
                r"(doesn'?t|does not) matter which (kind of )?doctor",
            ]
        ),
        ["specialty", "areas"],
    ),
    (r"anywhere(?! in)|any city|any location|(city|location) (doesn'?t|does not) matter", ["city"]),
    (r"any language|languages? (doesn'?t|does not) matter", ["language"]),
    (
        "|".join(
            [
                r"(online or in[- ]?person|in[- ]?person or online|online or (at )?(the )?clinic),?"
                r" (is |are )?(both |either )?(fine|okay|ok)",
                r"(don'?t|do not) mind online or",
                r"either way is fine",
            ]
        ),
        ["consultationMode"],
    ),
    (r"any (doctor'?s )?name|(doesn'?t|does not) have to be (dr|doctor)", ["doctorName"]),
]
_SHOW_OTHERS = "|".join(
    [
        r"other (doctors|options)",
        r"someone else",
        r"not (this|that) doctor",
        r"show me (more|others)",
        r"different doctor",
    ]
)
_UNSUPPORTED = [
    (r"\b(female|woman|lady|male|man)\b (doctor|dr|gp|physician|specialist)", "gender"),
    (r"\b(cheap|cheaper|cheapest|affordable|low[- ]cost|fees?|price)\b", "fees"),
    (r"\b(top[- ]rated|best[- ]rated|ratings?|reviews?)\b", "ratings"),
    (r"\binsurance\b", "insurance"),
    (r"\b(young|younger|older) (doctor|dr)\b", "age"),
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
    # People also ask to talk to, speak to or see someone, without saying doctor.
    if has_specialty or re.search(
        r"doctor|specialist|\bdr\b|physician|(talk|speak) to someone|see someone", t
    ):
        return "find_doctor"
    return "unsupported"


def care_assistant_intent(request: LLMRequest) -> dict[str, Any]:
    content = request.messages[-1].content
    match = _MESSAGE.search(content)
    text = match.group(1) if match else ""
    low = text.lower()
    allowed_line = _ALLOWED.search(content)
    allowed = {s.strip() for s in allowed_line.group(1).split(",")} if allowed_line else set()
    areas_line = _ALLOWED_AREAS.search(content)
    allowed_areas = (
        {item.split("=", 1)[0].strip() for item in areas_line.group(1).split(";") if "=" in item}
        if areas_line
        else set()
    )
    areas = [code for pattern, code in _AREAS if re.search(pattern, low) and code in allowed_areas]

    specialty, from_concern = None, False
    for pattern, name in _NAMED:
        if re.search(pattern, low) and name in allowed:
            specialty = name
            break
    options: list[str] = []
    if specialty is None:
        for pattern, names in _AMBIGUOUS:
            if re.search(pattern, low):
                options = [n for n in names if n in allowed]
                break
    if specialty is None and len(options) < 2:
        options = []
        for pattern, name in _CONCERN:
            if re.search(pattern, low) and name in allowed:
                specialty, from_concern = name, True
                break
    remove = list(
        dict.fromkeys(c for pattern, cs in _REMOVE if re.search(pattern, low) for c in cs)
    )
    unsupported = [code for pattern, code in _UNSUPPORTED if re.search(pattern, low)]

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
    ordinal = re.search(r"\b(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)\b", low)
    pick = (
        {"first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5}.get(ordinal.group(1))
        or int(ordinal.group(1)[0])
        if ordinal and re.search(r"\b(one|doctor|dr)\b", low)
        else None
    )
    clock = re.search(r"\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\b(\d{1,2}):(\d{2})\b", low)
    time = None
    if clock and clock.group(3):
        hour = int(clock.group(1)) % 12 + (12 if clock.group(3) == "pm" else 0)
        time = f"{hour:02d}:{clock.group(2) or '00'}"
    elif clock:
        time = f"{int(clock.group(4)):02d}:{clock.group(5)}"

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
        "areas": list(dict.fromkeys(areas))[:3],
        "specialtyOptions": options,
        "remove": remove,
        "showOthers": bool(re.search(_SHOW_OTHERS, low)),
        "pickDoctor": pick,
        "time": time,
        "unsupported": list(dict.fromkeys(unsupported)),
    }
