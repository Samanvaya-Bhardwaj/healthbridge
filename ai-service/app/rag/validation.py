"""Citation and safety validation for generated answers and briefs (ADR-0010, ADR-0024).

A sentence survives only if it:
  - cites at least one source, and only sources that were actually provided;
  - contains no number that is absent from every source it cites;
  - is lexically supported: most of its content words appear in the sources it cites;
  - contains no diagnostic, prescribing or treatment-changing language.
Anything else is removed; nothing is rewritten. No surviving sentence → the fixed
insufficient-information answer.
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
        text = str(sentence.get("text") or "").strip()
        labels = [str(c) for c in (sentence.get("citations") or [])]
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
            and not _UNSAFE.search(text)
        )
        if not valid:
            removed += 1
            continue
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
