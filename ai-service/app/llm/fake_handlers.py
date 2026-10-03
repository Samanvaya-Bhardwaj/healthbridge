"""Deterministic stand-ins for LLM workflows (fake provider: dev, tests, demo).

They read only the delimited document/context in the request and quote it exactly, so
the same grounding and citation validators apply as for a real model. They are rule
based, not intelligent: they recognise the synthetic report format used by the demo.
"""

import re
from collections.abc import Callable
from typing import Any

from app.llm.base import LLMRequest

_DOC = re.compile(r"<document>\n?(.*?)\n?</document>", re.S)
_LAB_LINE = re.compile(
    r"^\s*(?P<analyte>[A-Za-z][A-Za-z0-9 ()/%,.+-]{1,58}?)\s*[:\t]\s*"
    r"(?P<value>[<>]?\d+(?:\.\d+)?)\s*"
    r"(?P<unit>[A-Za-zµ%/^0-9.]{1,15}(?:/[A-Za-z0-9.]{1,10})?)?\s*"
    r"(?:\(\s*(?:ref(?:erence)?(?:\s*range)?\s*[:\s]\s*)?"
    r"(?P<range>\d+(?:\.\d+)?\s*[-–]\s*\d+(?:\.\d+)?)\s*\))?\s*$",  # noqa: RUF001 - en dash ranges
    re.I,
)
_DATE = re.compile(
    r"^(?P<line>.*?\b(?:report date|date|collected|sample date)\b\s*[:\-]?\s*"
    r"(?P<value>\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{4}|\d{1,2} [A-Za-z]{3,9} \d{4}))",
    re.I | re.M,
)
_ISSUER = re.compile(
    r"^(?P<value>[^\n]{3,120}?"
    r"\b(?:laborator(?:y|ies)|diagnostics|hospital|clinic|imaging centre)\b[^\n]{0,40})$",
    re.I | re.M,
)
_KEYWORDS = [
    ("discharge_summary", ("discharge summary", "date of discharge", "admitted on")),
    ("imaging", ("x-ray", "radiology", "mri", "ct scan", "ultrasound", "impression:")),
    ("prescription", ("rx", "prescription", "tablet", "capsule", "twice daily", "once daily")),
    ("lab_report", ("reference", "laboratory", "haemoglobin", "hemoglobin", "glucose", "test")),
]


def document_text(request: LLMRequest) -> str:
    match = _DOC.search(request.messages[-1].content)
    return match.group(1) if match else ""


def classify(request: LLMRequest) -> dict[str, Any]:
    text = document_text(request).lower()
    for doc_type, words in _KEYWORDS:
        hits = sum(1 for w in words if w in text)
        if hits:
            return {"documentType": doc_type, "confidence": 0.9 if hits > 1 else 0.6}
    return {"documentType": "other", "confidence": 0.3}


def extract(request: LLMRequest) -> dict[str, Any]:
    text = document_text(request)
    labs = []
    for line in text.splitlines():
        if _DATE.search(line):
            continue
        m = _LAB_LINE.match(line)
        if m:
            labs.append(
                {
                    "analyte": m["analyte"].strip(" :"),
                    "value": m["value"],
                    "unit": m["unit"],
                    "referenceRange": m["range"],
                    "quote": line.strip(),
                }
            )
    date = _DATE.search(text)
    issuer = _ISSUER.search(text)
    return {
        "documentDate": {"value": date["value"], "quote": date["line"].strip()} if date else None,
        "issuer": {"value": issuer["value"].strip(), "quote": issuer["value"].strip()}
        if issuer
        else None,
        "labResults": labs[:100],
    }


_SOURCE = re.compile(r"^\[(?P<label>[SF]\d+)\] (?P<text>.*?)(?=^\[[SF]\d+\] |\Z)", re.M | re.S)
_QUESTION = re.compile(r"<question>\n(.*?)\n</question>", re.S)
_STOP = {
    "what",
    "which",
    "were",
    "does",
    "with",
    "from",
    "have",
    "that",
    "this",
    "about",
    "the",
    "and",
    "any",
    "her",
    "his",
    "their",
    "patient",
    "value",
    "values",
    "result",
    "results",
}


def _sources(request: LLMRequest) -> list[tuple[str, str]]:
    body = request.messages[-1].content
    inner = body.split("<sources>\n", 1)[-1].rsplit("\n</sources>", 1)[0]
    return [(m["label"], m["text"].strip()) for m in _SOURCE.finditer(inner)]


def answer(request: LLMRequest) -> dict[str, Any]:
    """Quotes the first source line containing a question keyword, with its label."""
    q = _QUESTION.search(request.messages[-1].content)
    words = [
        w
        for w in re.findall(r"[a-z0-9]+", (q.group(1) if q else "").lower())
        if len(w) > 2 and w not in _STOP
    ]
    sentences = []
    for label, text in _sources(request):
        for line in text.splitlines():
            if any(w in line.lower() for w in words):
                sentences.append({"text": line.strip(), "citations": [label]})
                break
        if len(sentences) >= 3:
            break
    return {"sentences": sentences}


def brief(request: LLMRequest) -> dict[str, Any]:
    labs, docs = [], []
    for label, text in _sources(request):
        first = text.splitlines()[0].strip() if text else ""
        if not first:
            continue
        target = labs if label.startswith("F") else docs
        target.append({"text": first, "citations": [label]})
    sections = []
    if labs:
        sections.append({"heading": "Recent verified lab values", "sentences": labs[:10]})
    if docs:
        sections.append({"heading": "Documents on file", "sentences": docs[:6]})
    return {"sections": sections}


Handler = Callable[[LLMRequest], Any]

DEFAULT_HANDLERS: dict[str, Handler] = {
    "document_classification": classify,
    "document_extraction": extract,
    "record_question": answer,
    "doctor_brief": brief,
}
