"""The health library (ADR-0040): general information on common complaints.

Articles are Markdown files in `articles/`, written for patients and versioned with the
code. Each one names the words that match it and has fixed sections: an overview, what the
problem is often linked with, what may help, when to see a doctor and, for most, when to
get urgent help. The lists are shown word for word; a model only summarises them.

Only approved articles (reviewed by a clinician, with their name and the date) are served
in production. Draft articles are for development and testing.
"""

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.rag.retrieval import Source

ARTICLES_DIR = Path(__file__).parent / "articles"
_ID = re.compile(r"^[a-z_]{2,40}$")
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
SECTIONS = {
    "often linked with": "linked",
    "what may help": "help",
    "see a doctor if": "see_doctor",
    "get urgent help if": "urgent",
}
REQUIRED_SECTIONS = ("linked", "help", "see_doctor")
# "I don't have a fever" does not match fever.
_NEGATED = re.compile(r"\b(no|not|never|without|don'?t have|do not have|didn'?t have)\s+(an?\s+)?$")


class LibraryError(ValueError):
    pass


@dataclass(frozen=True)
class Article:
    id: str
    title: str
    patterns: tuple[re.Pattern[str], ...]
    review: str
    reviewed_by: str | None
    reviewed_on: str | None
    overview: str
    linked: tuple[str, ...]
    help: tuple[str, ...]
    see_doctor: tuple[str, ...]
    urgent: tuple[str, ...]

    def view(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "overview": self.overview,
            "linkedWith": list(self.linked),
            "mayHelp": list(self.help),
            "seeDoctorIf": list(self.see_doctor),
            "urgentIf": list(self.urgent),
            "review": {
                "status": self.review,
                "reviewedBy": self.reviewed_by,
                "reviewedOn": self.reviewed_on,
            },
        }


def parse_article(text: str, name: str = "article") -> Article:
    if not text.startswith("---\n"):
        raise LibraryError(f"{name}: missing front matter")
    head, _, body = text[4:].partition("\n---\n")
    meta: dict[str, str] = {}
    patterns: list[str] = []
    in_match = False
    for line in head.splitlines():
        if in_match and line.startswith("  ") and line.strip():
            patterns.append(line.strip())
            continue
        in_match = False
        key, sep, value = line.partition(":")
        if not sep:
            raise LibraryError(f"{name}: bad front matter line {line!r}")
        key = key.strip()
        if key == "match":
            in_match = True
        else:
            meta[key] = value.strip()
    article_id = meta.get("id", "")
    if not _ID.match(article_id):
        raise LibraryError(f"{name}: bad id {article_id!r}")
    if not meta.get("title"):
        raise LibraryError(f"{name}: missing title")
    review = meta.get("review")
    if review not in ("draft", "approved"):
        raise LibraryError(f"{name}: review must be draft or approved")
    if review == "approved" and not (
        meta.get("reviewed_by") and _DATE.match(meta.get("reviewed_on", ""))
    ):
        raise LibraryError(f"{name}: an approved article needs reviewed_by and reviewed_on")
    if not patterns:
        raise LibraryError(f"{name}: no match patterns")
    try:
        compiled = tuple(re.compile(rf"\b(?:{p})\b", re.I) for p in patterns)
    except re.error as exc:
        raise LibraryError(f"{name}: bad match pattern: {exc}") from exc

    overview: list[str] = []
    sections: dict[str, list[str]] = {}
    current: str | None = None
    for raw in body.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("## "):
            heading = line[3:].strip().lower()
            if heading not in SECTIONS:
                raise LibraryError(f"{name}: unknown section {heading!r}")
            current = SECTIONS[heading]
            sections[current] = []
        elif current is None:
            overview.append(line)
        elif line.startswith("- "):
            sections[current].append(line[2:].strip())
        else:
            raise LibraryError(f"{name}: text outside a list in {current}")
    for key in REQUIRED_SECTIONS:
        if not sections.get(key):
            raise LibraryError(f"{name}: missing section {key}")
    if not overview:
        raise LibraryError(f"{name}: missing overview")
    for items in sections.values():
        if any(len(item) > 200 for item in items):
            raise LibraryError(f"{name}: a list item is longer than 200 characters")
    return Article(
        id=article_id,
        title=meta["title"],
        patterns=compiled,
        review=review,
        reviewed_by=meta.get("reviewed_by") or None,
        reviewed_on=meta.get("reviewed_on") or None,
        overview=" ".join(overview),
        linked=tuple(sections["linked"]),
        help=tuple(sections["help"]),
        see_doctor=tuple(sections["see_doctor"]),
        urgent=tuple(sections.get("urgent", [])),
    )


def load_library(*, production: bool, directory: Path = ARTICLES_DIR) -> list[Article]:
    """Every article, or in production only the approved ones. Malformed files fail loudly."""
    articles = [
        parse_article(p.read_text(encoding="utf-8"), p.name) for p in sorted(directory.glob("*.md"))
    ]
    ids = [a.id for a in articles]
    if len(ids) != len(set(ids)):
        raise LibraryError("duplicate article ids")
    return [a for a in articles if a.review == "approved"] if production else articles


def _hits(article: Article, message: str) -> list[re.Match[str]]:
    found = []
    for pattern in article.patterns:
        for m in pattern.finditer(message):
            if not _NEGATED.search(message[max(0, m.start() - 20) : m.start()].lower()):
                found.append(m)
                break
    return found


def match(message: str, articles: list[Article]) -> Article | None:
    """The article whose words the message uses most (then the longest match); or None."""
    best: tuple[int, int, int] | None = None
    chosen: Article | None = None
    for index, article in enumerate(articles):
        hits = _hits(article, message)
        if not hits:
            continue
        score = (len(hits), max(len(h.group(0)) for h in hits), -index)
        if best is None or score > best:
            best, chosen = score, article
    return chosen


def sources(article: Article) -> list[Source]:
    """Passages for the summary: overview, causes, what may help, when to see a doctor.

    Each carries the article title and section, so a summary sentence that names them is
    still supported by its source. Urgent warning signs are left out: the summary never
    talks about urgency; they are shown word for word instead.
    """
    items = [("overview", article.overview)]
    items += [("often linked with", t) for t in article.linked]
    items += [("what may help", t) for t in article.help]
    items += [("see a doctor if", t) for t in article.see_doctor]
    return [
        Source(
            f"L{i + 1}",
            "health_article",
            f"{article.id}:{i + 1}",
            None,
            f"{article.title}, {heading}: {text}",
        )
        for i, (heading, text) in enumerate(items)
    ]
