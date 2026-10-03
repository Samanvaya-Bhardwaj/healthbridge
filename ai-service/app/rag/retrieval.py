"""Hybrid retrieval over one patient's document chunks.

Runs on a patient-scoped connection (RLS: only `ai.patient_id`) and is further limited to
the document IDs in the verified scope token — the documents the backend authorised for
this reader — and to the latest extraction of each document. No query can reach another
patient's or an unauthorised document's text.
"""

import re
from dataclasses import dataclass
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


@dataclass(frozen=True)
class Source:
    label: str
    source_type: str  # "document_chunk" | "fact"
    source_id: str
    document_id: str | None
    text: str
    score: float = 0.0


def terms(text: str) -> list[str]:
    return [t for t in _WORD.findall(text.lower()) if len(t) > 2 and t not in STOPWORDS]


_LATEST = """
  SELECT c.id::text, c.document_id::text, c.content, {score} AS score
    FROM ai.document_chunks c
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
        "q": " ".join(terms(query)) or query,
        "limit": 20,
    }
    vec_rows = await (
        await conn.execute(
            _LATEST.format(score="1 - (c.embedding <=> %(vec)s::extensions.vector)", extra=""),
            params,
        )
    ).fetchall()
    text_rows = await (
        await conn.execute(
            _LATEST.format(
                score="ts_rank(c.tsv, plainto_tsquery('simple', %(q)s))",
                extra="AND c.tsv @@ plainto_tsquery('simple', %(q)s)",
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


def rerank(query: str, sources: list[Source], *, limit: int = 6) -> list[Source]:
    """Deterministic lexical rerank: query-term overlap first, fused score second."""
    q = set(terms(query))

    def key(s: Source) -> tuple[int, float]:
        return (len(q & set(terms(s.text))), s.score)

    ordered = sorted(sources, key=key, reverse=True)[:limit]
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
            )
        )
    return out


def overlap(query: str, source: Source) -> int:
    return len(set(terms(query)) & set(terms(source.text)))
