"""Hybrid retrieval over one patient's document chunks.

Runs on a patient-scoped connection (RLS: only `ai.patient_id`) and is further limited to
the document IDs in the verified scope token — the documents the backend authorised for
this reader — and to the latest extraction of each document. No query can reach another
patient's or an unauthorised document's text.
"""

import re
from dataclasses import dataclass, replace
from typing import Any

from app.embeddings import EmbeddingProvider, to_pgvector

RRF_K = 60
_WORD = re.compile(r"[a-z0-9]+(?:\.[0-9]+)?")
_STOPWORD_TEXT = """
the a an and or of to in on for with what is are was were has have had any did does do this
that these those from by at as be been it its their there which who whom how when patient
patients report reports value values level levels result results show shows
"""
STOPWORDS = frozenset(_STOPWORD_TEXT.split())
# Short words that do carry meaning here.
_SHORT_TERMS = frozenset({"bp", "hb", "t3", "t4"})
# The everyday word and what a report calls it, so "how are my kidneys?" finds a creatinine
# result. For finding sources only: an answer's words must still come from those sources.
_SAME_TOPIC: dict[str, tuple[str, ...]] = {
    "kidney": ("creatinine", "egfr", "urea", "microalbumin", "renal"),
    "sugar": ("glucose", "hba1c", "fbs", "ppbs"),
    "diabetes": ("glucose", "hba1c"),
    "cholesterol": ("lipid", "ldl", "hdl", "triglycerides"),
    "thyroid": ("tsh", "t3", "t4"),
    "bp": ("pressure", "systolic", "diastolic"),
    "anaemia": ("haemoglobin", "hemoglobin", "ferritin", "iron"),
    "anaemic": ("haemoglobin", "hemoglobin", "ferritin", "iron"),
    "anemia": ("haemoglobin", "hemoglobin", "ferritin", "iron"),
    "anemic": ("haemoglobin", "hemoglobin", "ferritin", "iron"),
    "heart": ("ecg", "echo", "echocardiogram", "cardiac"),
    "liver": ("sgpt", "sgot", "alt", "ast", "bilirubin"),
    "eye": ("retinal", "retina", "fundus", "acuity"),
}


@dataclass(frozen=True)
class Source:
    label: str
    source_type: str  # "document_chunk" | "fact"
    source_id: str
    document_id: str | None
    text: str
    score: float = 0.0
    date: str | None = None  # the date on the document or lab value, when known


def terms(text: str) -> list[str]:
    return [
        t
        for t in _WORD.findall(text.lower())
        if (len(t) > 2 or t in _SHORT_TERMS) and t not in STOPWORDS
    ]


def _with_singulars(words: list[str]) -> set[str]:
    return {*words, *(w[:-1] for w in words if len(w) > 3 and w.endswith("s"))}


def search_terms(query: str) -> set[str]:
    """What to look for: the question's words, their singulars and their report names."""
    words = _with_singulars(terms(query))
    return words | {same for word in words for same in _SAME_TOPIC.get(word, ())}


def any_term_query(query: str) -> str:
    """A text query matching any term: rank decides, so one extra word ("last") can't empty it.

    Terms hold only letters, digits and dots, so quoting them is safe.
    """
    return " | ".join(f"'{t}'" for t in sorted(search_terms(query)))


_LATEST = """
  SELECT c.id::text, c.document_id::text, c.content, {score} AS score
    FROM ai.document_chunks c
    {join}
   WHERE c.document_id = ANY(%(docs)s::uuid[])
     AND c.extraction_id IN (
       SELECT DISTINCT ON (e.document_id) e.id FROM ai.document_extractions e
        WHERE e.document_id = ANY(%(docs)s::uuid[]) AND e.status <> 'failed'
        ORDER BY e.document_id, e.version DESC)
     {extra}
   ORDER BY score DESC
   LIMIT %(limit)s
"""


async def hybrid_search(
    conn: Any,
    embedder: EmbeddingProvider,
    query: str,
    document_ids: list[str],
    *,
    limit: int = 6,
) -> list[Source]:
    if not document_ids:
        return []
    vector = to_pgvector((await embedder.embed([query], kind="query"))[0])
    params = {
        "docs": document_ids,
        "vec": vector,
        "q": any_term_query(query),
        "limit": 20,
        "model": embedder.model_id,
    }
    vec_rows = await (
        await conn.execute(
            # Vectors are comparable only within one model: the chunk's own, or one of the
            # current model added after a switch (ai.chunk_vectors). Lexical ranking
            # covers the rest.
            _LATEST.format(
                join=("LEFT JOIN ai.chunk_vectors v ON v.chunk_id = c.id AND v.model = %(model)s"),
                score=(
                    "1 - (CASE WHEN c.embedding_model = %(model)s THEN c.embedding"
                    " ELSE v.embedding END <=> %(vec)s::extensions.vector)"
                ),
                extra="AND (c.embedding_model = %(model)s OR v.chunk_id IS NOT NULL)",
            ),
            params,
        )
    ).fetchall()
    text_rows = []
    if params["q"]:
        text_rows = await (
            await conn.execute(
                _LATEST.format(
                    join="",
                    score="ts_rank(c.tsv, to_tsquery('simple', %(q)s))",
                    extra="AND c.tsv @@ to_tsquery('simple', %(q)s)",
                ),
                params,
            )
        ).fetchall()
    # Reciprocal-rank fusion of the two rankings.
    fused: dict[str, dict[str, Any]] = {}
    for ranking in (vec_rows, text_rows):
        for rank, (chunk_id, document_id, content, _score) in enumerate(ranking):
            entry = fused.setdefault(chunk_id, {"doc": document_id, "text": content, "score": 0.0})
            entry["score"] += 1.0 / (RRF_K + rank + 1)
    ranked = sorted(fused.items(), key=lambda kv: kv[1]["score"], reverse=True)[: limit * 2]
    return [
        Source(f"S{i + 1}", "document_chunk", cid, v["doc"], v["text"], v["score"])
        for i, (cid, v) in enumerate(ranked)
    ]


def dated(sources: list[Source], dates: dict[str, str]) -> list[Source]:
    """Puts each document's date on its chunks, in the text the model and validator read.

    "Latest" means nothing without it, and a sentence may then quote the date.
    """
    return [
        replace(s, text=f"Document date: {day}. {s.text}", date=day)
        if s.document_id and (day := dates.get(s.document_id))
        else s
        for s in sources
    ]


def rerank(query: str, sources: list[Source], *, limit: int = 6) -> list[Source]:
    """Deterministic lexical rerank: the best by query-term overlap, then fused score, kept
    newest first (undated last), so "latest" reads from the top."""
    q = search_terms(query)

    def key(s: Source) -> tuple[int, float]:
        return (len(q & _with_singulars(terms(s.text))), s.score)

    best = sorted(sources, key=key, reverse=True)[:limit]
    ordered = sorted(best, key=lambda s: s.date or "", reverse=True)
    # Labels keep their kind: S# for document chunks, F# for verified facts.
    counters = {"S": 0, "F": 0}
    out = []
    for s in ordered:
        prefix = "S" if s.source_type == "document_chunk" else "F"
        counters[prefix] += 1
        out.append(
            Source(
                f"{prefix}{counters[prefix]}",
                s.source_type,
                s.source_id,
                s.document_id,
                s.text,
                s.score,
                s.date,
            )
        )
    return out


def overlap(query: str, source: Source) -> int:
    return len(search_terms(query) & _with_singulars(terms(source.text)))
