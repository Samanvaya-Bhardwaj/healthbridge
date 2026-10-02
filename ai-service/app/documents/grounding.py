"""Grounding, chunking and injection screening for document extraction (ADR-0010).

A proposed field is kept only if its quote is literally present in the document text
(whitespace- and case-insensitive) and its value appears inside that quote. Anything else
is dropped: never "corrected", never stored as a trusted value.
"""

import re
from typing import Any

_WS = re.compile(r"\s+")

INJECTION_PATTERNS: dict[str, re.Pattern[str]] = {
    "ignore_instructions": re.compile(
        r"\b(ignore|disregard|forget)\b.{0,40}\b(previous|prior|above|all|earlier)\b.{0,30}"
        r"\b(instructions?|rules?|prompts?)\b",
        re.I | re.S,
    ),
    "role_override": re.compile(r"\b(you are now|act as|new instructions?|system prompt)\b", re.I),
    "tool_or_action": re.compile(
        r"\b(call|invoke|execute|run)\b.{0,20}\b(tool|function|command|api)\b", re.I | re.S
    ),
    "markup": re.compile(r"<\s*(script|iframe|img|svg)\b", re.I),
    "exfiltration": re.compile(
        r"\b(send|email|post|upload)\b.{0,30}\b(to|at)\b.{0,10}https?://", re.I | re.S
    ),
}


def normalise(text: str) -> str:
    return _WS.sub(" ", text).strip().lower()


def detect_injection(text: str) -> list[str]:
    """Pattern flags for instruction-like content inside a document (data, not commands)."""
    return sorted(name for name, pattern in INJECTION_PATTERNS.items() if pattern.search(text))


def _value_in_quote(value: str, quote: str) -> bool:
    v = normalise(str(value))
    return bool(v) and v in normalise(quote)


def validate_fields(fields: list[dict[str, Any]], text: str) -> tuple[list[dict[str, Any]], int]:
    """Keep only grounded fields. Returns (kept, dropped_count)."""
    haystack = normalise(text)
    kept: list[dict[str, Any]] = []
    seen: set[str] = set()
    dropped = 0
    for field in fields:
        quote = str(field.get("quote") or "")
        value = field.get("value")
        key = str(field.get("key") or "")
        grounded = (
            bool(key)
            and key not in seen
            and len(quote) <= 500
            and normalise(quote) in haystack
            and normalise(quote) != ""
            and value is not None
            and _value_in_quote(value, quote)
        )
        if not grounded:
            dropped += 1
            continue
        seen.add(key)
        kept.append(field)
    return kept, dropped


def chunk_text(text: str, *, size: int = 900, overlap: int = 120) -> list[str]:
    """Paragraph-aware chunks of at most `size` characters with a small overlap."""
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n|\n", text) if p.strip()]
    chunks: list[str] = []
    current = ""
    for paragraph in paragraphs:
        while len(paragraph) > size:  # very long lines are split hard
            head, paragraph = paragraph[:size], paragraph[size - overlap :]
            if current:
                chunks.append(current)
                current = ""
            chunks.append(head)
        if len(current) + len(paragraph) + 1 > size and current:
            chunks.append(current)
            current = current[-overlap:] + "\n" + paragraph if overlap else paragraph
        else:
            current = f"{current}\n{paragraph}" if current else paragraph
    if current.strip():
        chunks.append(current)
    return [c[:4000] for c in chunks if c.strip()][:400]
