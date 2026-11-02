"""Citation and safety validation for generated answers and briefs (ADR-0010, ADR-0024).

A sentence survives only if it:
  - cites at least one source, and only sources that were actually provided;
  - contains no number that is absent from every source it cites;
  - is lexically supported: most of its content words appear in the sources it cites;
  - contains no diagnostic, prescribing or treatment-changing language.
Anything else is removed, as is a sentence that says what a result means. Two things are
taken out of a sentence first: the source labels it names, and an interpretation added to
a fact after a comma ("..., indicating ..."). A sentence that keeps its place gets its
source's date, when it has one and lacks it. Nothing else is rewritten. No surviving
sentence → the fixed insufficient-information answer.
"""

import re
from typing import Any

from app.rag.retrieval import Source, terms

INSUFFICIENT = "Insufficient information. Please consult the doctor."
_NUMBER = re.compile(r"\d+(?:\.\d+)?")
_UNSAFE = re.compile(
    r"\b(diagnos(?:e|es|ed|is|ing)|you (?:have|may have|likely have)|prescrib\w*|"
    r"start(?:ing)? (?:on|taking)|"
    r"stop(?:ping)? (?:taking|the)|increase the dose|decrease the dose|dosage|recommend(?:ed)? "
    r"(?:starting|stopping|treatment|therapy))\b",
    re.I,
)
MAX_SENTENCE_CHARS = 400
MIN_SUPPORT = 0.6
# What a model adds to a fact: "HbA1c is 6.1 %, indicating prediabetes". Saying what results
# mean is the doctor's job, so the clause goes and the fact stays.
_INTERPRETATION = re.compile(
    r"[,;]\s*(?:which\s+)?\b(?:indicat\w+|suggest\w+|implying|meaning|consistent with"
    r"|pointing to)\b.*$",
    re.I,
)
# As the sentence's own verb there is no fact to keep: "6.5% is consistent with diabetes".
_MEANING = re.compile(
    r"\b(?:indicat(?:e|es|ing)|suggest(?:s|ing|ive)?|consistent with|implies|means"
    r"|appears? to|seems? to)\b",
    re.I,
)


def without_labels(text: str, labels: list[str]) -> str:
    """The sentence as a person reads it, without the labels it cites ("According to S3, ...").

    A label's digits would also fail the number check. Only the labels this sentence cites
    go: "L5" and "S1" can be medical words too.
    """
    names = "|".join(re.escape(label) for label in labels)
    if not names:
        return text.strip()
    label = rf"\[?\b(?:{names})\b\]?"
    several = rf"{label}(?:\s*(?:,|and|&)\s*{label})*"
    lead_in = r"(?:according to|as per|as shown in|based on|per|from|in|see)"
    kind = r"(?:the\s+)?(?:tests?|sources?|reports?|documents?)?"
    mention = re.compile(
        rf"\s*\(\s*{several}\s*\)|(?:\s*\b{lead_in}\s+{kind}\s*)?\s*{several}[,;]?", re.I
    )
    cleaned = re.sub(r"\s+([.,;])", r"\1", mention.sub(" ", text))
    cleaned = " ".join(re.sub(r"[,;]+(?=[.!?]|\s*$)", "", cleaned).split())
    return cleaned[:1].upper() + cleaned[1:]


def facts_only(text: str) -> str:
    """The sentence without an interpretation added to it. What's left is validated as usual."""
    kept = _INTERPRETATION.sub("", text).rstrip(" ,;.")
    return f"{kept}." if kept and kept != text.rstrip(" ,;.") else text


def with_date(text: str, cited: list[Source]) -> str:
    """Says when, from the source itself: three HbA1c values mean nothing without their dates."""
    days = {s.date for s in cited if s.date}
    if len(days) != 1 or (day := days.pop()) in text:
        return text
    return f"{text.rstrip(' .')} (report dated {day})."


def support(text: str, cited: list[Source]) -> float:
    words = set(terms(text))
    if not words:
        return 0.0
    available = set().union(*(set(terms(s.text)) for s in cited)) if cited else set()
    return len(words & available) / len(words)


def validate_sentences(
    sentences: list[dict[str, Any]], sources: list[Source]
) -> tuple[list[dict[str, Any]], int]:
    """Returns (kept sentences with resolved citations, removed count)."""
    by_label = {s.label: s for s in sources}
    kept: list[dict[str, Any]] = []
    removed = 0
    for sentence in sentences:
        labels = [str(c) for c in (sentence.get("citations") or [])]
        said = without_labels(str(sentence.get("text") or ""), labels)
        text = facts_only(said)
        cited = [by_label[label] for label in dict.fromkeys(labels) if label in by_label]
        numbers_ok = all(
            any(n in _NUMBER.findall(s.text) for s in cited) for n in _NUMBER.findall(text)
        )
        valid = (
            bool(text)
            and len(text) <= MAX_SENTENCE_CHARS
            and cited
            and len(cited) == len(dict.fromkeys(labels))
            and numbers_ok
            and support(text, cited) >= MIN_SUPPORT
            # The sentence as written: a diagnosis isn't saved by trimming it.
            and not _UNSAFE.search(said)
            and not _MEANING.search(text)
        )
        if not valid:
            removed += 1
            continue
        text = with_date(text, cited)
        citations = [
            {
                "label": s.label,
                "type": s.source_type,
                "id": s.source_id,
                "documentId": s.document_id,
            }
            for s in cited
        ]
        # The same statement drawn from duplicate uploads is shown once, citing every copy.
        duplicate = next((k for k in kept if k["text"].casefold() == text.casefold()), None)
        if duplicate:
            known = {c["label"] for c in duplicate["citations"]}
            duplicate["citations"].extend(c for c in citations if c["label"] not in known)
            continue
        kept.append({"text": text, "citations": citations})
    return kept, removed
