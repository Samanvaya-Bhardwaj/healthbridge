"""Wording the care assistant reads by code (ADR-0041).

A small local model over-fills the form: it took "a dermatologist" for a doctor's name,
dropped the city from "in Bangalore" and chose areas of practice nobody mentioned. What can
be read from the person's own words is therefore read here, and the validator keeps a value
from the model only if those words support it. The offline fake model uses the same tables,
so tests run the phrasing the validator accepts.

Patterns search lower-case or mixed text (re.I). They are wording, never a diagnosis.
"""

import re

_I = re.I

# Which area of practice the person's words name (a doctor's listed focus, never a
# condition they are told they have). The validator keeps only areas that fit the specialty,
# so a few candidates per message are fine.
AREA_WORDS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(pattern, _I), code)
    for pattern, code in (
        (r"pimple|acne|breakout", "acne"),
        (r"eczema|dermatitis", "eczema"),
        (r"psoriasis", "psoriasis"),
        (r"hair ?(fall|loss)|losing (my )?hair|bald", "hair_loss"),
        (r"rash|hives|itch|skin allerg", "skin_allergies"),
        (r"pigment|dark spots", "pigmentation"),
        (r"fever|infection", "fever_infections"),
        (r"diabet|blood sugar|sugar level", "diabetes"),
        (r"blood pressure|\bbp\b|hypertension", "blood_pressure"),
        (r"check[- ]?up|health check", "health_checkups"),
        (r"\bweight\b|obes", "weight_lifestyle"),
        (r"elderly|old age", "elderly_care"),
        (r"chronic|long[- ]term condition", "long_term_conditions"),
        (r"growth|development|milestone", "child_growth"),
        (r"vaccin|immuni[sz]", "vaccinations"),
        (r"new ?born", "newborn_care"),
        (r"fever|infection", "childhood_infections"),
        (r"pregnan|expecting a baby", "pregnancy_care"),
        (r"\bperiods?\b|menstrua", "menstrual_health"),
        (r"fertility|trying to conceive", "fertility"),
        (r"menopause", "menopause"),
        (r"pcos|pcod", "pcos"),
        (r"palpitation|heart rhythm|irregular heart", "heart_rhythm"),
        (r"heart failure", "heart_failure"),
        (r"cholesterol", "cholesterol"),
        (r"cardiac rehab", "cardiac_rehab"),
        (r"joint|knee", "joint_pain"),
        (r"back ?(pain|ache)|neck pain", "back_neck_pain"),
        (r"sprain|sports injur", "sports_injuries"),
        (r"fracture|broken bone", "fractures"),
        (r"arthritis", "arthritis"),
        (r"hearing|ear ?ache|ear pain", "ear_hearing"),
        (r"sinus", "sinus"),
        (r"hoarse|lost my voice|throat pain|sore throat", "throat_voice"),
        (r"snor(e|ing)", "snoring"),
        (r"glasses|blurry|vision", "vision"),
        (r"cataract", "cataract"),
        (r"glaucoma", "glaucoma"),
        (r"eye infection|conjunctivitis|pink eye", "eye_infections"),
        (r"anxiety|anxious|panic", "anxiety"),
        (r"depress|low mood", "depression"),
        (r"can'?t sleep|insomnia|sleep problem", "sleep"),
        (r"addict", "addiction"),
        (r"headache|migraine", "headache_migraine"),
        (r"epilepsy", "epilepsy"),
        (r"nerve pain|sciatica|neuropathy", "nerve_pain"),
        (r"memory|forgetful", "memory"),
        (r"acidity|heart ?burn|reflux|\bgerd\b", "acidity_reflux"),
        (r"constipat|diarrh|loose motion|bowel", "bowel_problems"),
        (r"\bliver\b|jaundice|hepatitis", "liver"),
        (r"stomach (pain|ache)|abdominal pain|tummy|pet (mein|me) dard", "stomach_pain"),
        (r"thyroid", "thyroid"),
        (r"hormon", "hormones"),
        (r"asthma|wheez", "asthma"),
        (r"\bcopd\b", "copd"),
        (r"(long|persistent|lasting) cough|cough for (weeks|a month)", "long_cough"),
        (r"dust allergy|pollen|hay fever", "breathing_allergies"),
    )
]

# A kind of doctor named outright (not inferred from a concern).
NAMED_SPECIALTIES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(pattern, _I), name)
    for pattern, name in (
        (r"dermatolog|skin (specialist|doctor)", "Dermatology"),
        (r"p(a)?ediatric|child specialist", "Paediatrics"),
        (r"gyn(a)?ecolog|ob[- /]?gyn", "Gynaecology"),
        (r"cardiolog|heart (specialist|doctor)", "Cardiology"),
        (r"orthop(a)?edic|bone (specialist|doctor)", "Orthopaedics"),
        (r"\bent\b|ear,? nose", "ENT"),
        (r"ophthalmolog|eye (doctor|specialist)", "Ophthalmology"),
        (r"psychiatr", "Psychiatry"),
        (r"neurolog", "Neurology"),
        (r"gastroenterolog", "Gastroenterology"),
        (r"endocrinolog|diabetolog", "Endocrinology"),
        (r"pulmonolog|chest (physician|specialist)", "Pulmonology"),
        (r"general physician|general medicine|\bgp\b", "General Medicine"),
        (r"family doctor|family medicine|family physician", "Family Medicine"),
    )
]

# "I don't mind ..." wording, per criterion.
REMOVE_WORDS: list[tuple[re.Pattern[str], list[str]]] = [
    (
        re.compile(
            r"any (kind of |type of )?doctor|any (kind of )?speciali?t(y|ies)"
            r"|no preference (for|on) (the )?speciali"
            r"|(doesn'?t|does not) matter which (kind of )?doctor",
            _I,
        ),
        ["specialty", "areas"],
    ),
    (
        re.compile(
            r"anywhere(?! in)|any city|any location|(city|location) (doesn'?t|does not) matter", _I
        ),
        ["city"],
    ),
    (re.compile(r"any language|languages? (doesn'?t|does not) matter", _I), ["language"]),
    (
        re.compile(
            r"(online or in[- ]?person|in[- ]?person or online|online or (at )?(the )?clinic),?"
            r" (is |are )?(both |either )?(fine|okay|ok)"
            r"|(don'?t|do not) mind online or|either way is fine",
            _I,
        ),
        ["consultationMode"],
    ),
    (
        re.compile(r"any (doctor'?s )?name|(doesn'?t|does not) have to be (dr|doctor)", _I),
        ["doctorName"],
    ),
    (
        re.compile(
            r"any ?(day|date|time)\b|whenever|(day|time) (doesn'?t|does not) matter"
            r"|any other (day|time)",
            _I,
        ),
        ["date", "timeWindow"],
    ),
]
# Words without which the model's "no longer minds" is a guess.
INDIFFERENT = re.compile(
    r"\b(any\w*|either|whichever|whatever|whenever|(don'?t|do not) mind|(doesn'?t|does not) "
    r"matter|no preference|not important|fine)\b",
    _I,
)

SHOW_OTHERS = re.compile(
    r"other (doctors|options)|someone else|anyone else|not (this|that) doctor|show me (more|others)"
    r"|different doctor|another doctor|more doctors",
    _I,
)
# Without one of these, the model's "show others" is a guess.
OTHERS_WORDS = re.compile(r"\b(others?|else|different|another|more|next)\b", _I)
