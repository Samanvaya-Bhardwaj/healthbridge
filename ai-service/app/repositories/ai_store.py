"""SQL for the `ai` schema. Every function runs on a patient-scoped connection
(`Database.patient_scope`), so RLS confines it to the patient in the verified scope."""

import json
import uuid
from datetime import UTC, datetime
from typing import Any

from app.embeddings import to_pgvector
from app.llm.base import LLMResponse


def new_id() -> str:
    return str(uuid.uuid7()) if hasattr(uuid, "uuid7") else str(uuid.uuid4())


class RunTotals:
    """Accumulates LLM usage across the calls of one AI run (ADR-0012)."""

    def __init__(self) -> None:
        self.calls = 0
        self.input_tokens = 0
        self.output_tokens = 0
        self.cache_read = 0
        self.cache_write = 0
        self.cost: float | None = 0.0
        self.provider: str | None = None
        self.requested_model: str | None = None
        self.model: str | None = None

    def add(self, response: LLMResponse) -> None:
        self.calls += 1
        self.input_tokens += response.usage.input_tokens
        self.output_tokens += response.usage.output_tokens
        self.cache_read += response.usage.cache_read_input_tokens
        self.cache_write += response.usage.cache_creation_input_tokens
        self.provider = response.provider
        self.requested_model = response.requested_model
        self.model = response.model
        if response.estimated_cost_usd is None or self.cost is None:
            self.cost = None
        else:
            self.cost = round(self.cost + response.estimated_cost_usd, 6)


async def insert_run(
    conn: Any,
    *,
    run_id: str,
    workflow: str,
    agent: str,
    patient_id: str,
    status: str,
    totals: RunTotals,
    started_at: datetime,
    prompt_version: str,
    input_hash: str,
    validation: str | None,
    injection_flags: list[str],
    error_kind: str | None,
    request_id: str | None,
) -> None:
    ended = datetime.now(UTC)
    await conn.execute(
        """INSERT INTO ai.ai_runs (id, workflow, agent, patient_id, provider, requested_model,
             model, status, error_kind, output_validation_status, prompt_version, input_hash,
             llm_calls, input_tokens, output_tokens, cache_read_input_tokens,
             cache_creation_input_tokens, estimated_cost_usd, latency_ms, injection_flags,
             request_id, started_at, ended_at)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
        (
            run_id,
            workflow,
            agent,
            patient_id,
            totals.provider,
            totals.requested_model,
            totals.model,
            status,
            error_kind,
            validation,
            prompt_version,
            input_hash,
            totals.calls,
            totals.input_tokens,
            totals.output_tokens,
            totals.cache_read,
            totals.cache_write,
            totals.cost,
            round((ended - started_at).total_seconds() * 1000),
            injection_flags,
            request_id,
            started_at,
            ended,
        ),
    )


async def find_extraction(
    conn: Any, document_id: str, input_sha256: str, prompt_version: str
) -> dict[str, Any] | None:
    cur = await conn.execute(
        """SELECT id, version, status, text_source, classification, fields, dropped_field_count,
                  injection_flags, run_id
             FROM ai.document_extractions
            WHERE document_id = %s AND input_sha256 = %s AND prompt_version = %s
            ORDER BY version DESC LIMIT 1""",
        (document_id, input_sha256, prompt_version),
    )
    row = await cur.fetchone()
    if not row:
        return None
    keys = [
        "id",
        "version",
        "status",
        "text_source",
        "classification",
        "fields",
        "dropped_field_count",
        "injection_flags",
        "run_id",
    ]
    return dict(zip(keys, row, strict=True))


async def insert_extraction(
    conn: Any,
    *,
    extraction_id: str,
    patient_id: str,
    document_id: str,
    document_type: str,
    run_id: str,
    input_sha256: str,
    prompt_version: str,
    status: str,
    text_source: str,
    classification: dict[str, Any],
    fields: list[dict[str, Any]],
    dropped: int,
    injection_flags: list[str],
) -> int:
    cur = await conn.execute(
        "SELECT coalesce(max(version), 0) + 1 FROM ai.document_extractions WHERE document_id = %s",
        (document_id,),
    )
    (version,) = await cur.fetchone()
    await conn.execute(
        """INSERT INTO ai.document_extractions (id, patient_id, document_id, document_type, version,
             run_id, input_sha256, prompt_version, status, text_source, classification, fields,
             dropped_field_count, injection_flags)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
        (
            extraction_id,
            patient_id,
            document_id,
            document_type,
            version,
            run_id,
            input_sha256,
            prompt_version,
            status,
            text_source,
            json.dumps(classification),
            json.dumps(fields),
            dropped,
            injection_flags,
        ),
    )
    await conn.execute(
        """INSERT INTO ai.ai_sources (id, run_id, patient_id, source_type, source_id)
           VALUES (%s,%s,%s,'medical_document',%s)""",
        (new_id(), run_id, patient_id, document_id),
    )
    return version


async def insert_chunks(
    conn: Any,
    *,
    patient_id: str,
    document_id: str,
    document_type: str,
    extraction_id: str,
    chunks: list[str],
    vectors: list[list[float]],
) -> None:
    for index, (content, vector) in enumerate(zip(chunks, vectors, strict=True)):
        await conn.execute(
            """INSERT INTO ai.document_chunks (id, patient_id, document_id, document_type,
                 extraction_id, chunk_index, content, embedding)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s::extensions.vector)""",
            (
                new_id(),
                patient_id,
                document_id,
                document_type,
                extraction_id,
                index,
                content,
                to_pgvector(vector),
            ),
        )
