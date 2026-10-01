# ADR-0012: AI execution records (`ai_runs`) for observability

- **Status:** Accepted (structured telemetry in M0; persisted `ai.ai_runs` from M6)
- **Date:** 2026-10-01

## Context

We need to answer, for any AI output, questions such as: which model produced it, from
which sources, how long it took, what it cost, and whether it passed validation. We need
this without storing sensitive prompts and responses.

## Decision

Every AI execution creates an `ai.ai_runs` record with:

| Field | Notes |
|---|---|
| `run_id` | UUIDv7 |
| `workflow`, `agent` | e.g. `document_extraction`, `document_agent` |
| `provider`, `model` | the requested model and the model that served the request |
| `started_at`, `ended_at`, `latency_ms` | |
| `input_tokens`, `output_tokens`, cache tokens | |
| `estimated_cost_usd` | from a dated price table; `null` for unknown models, never a guess |
| `status`, `error_kind` | ok / refused / error |
| `source_ids` | via `ai.ai_sources` (one row per cited source) |
| `output_validation_status` | e.g. schema_valid, grounded, citations_valid, rejected |
| `request_id` | correlates with API and worker logs |
| `prompt_version`, `input_hash` | reproducibility without storing the input |

- **Raw prompts and responses are not stored unnecessarily.** We store hashes, prompt
  template versions, structured validated outputs (the AI artifact) and source
  references.
- In M0 the `InstrumentedLLMProvider` emits these fields as structured `llm_call` log
  events. The same hook persists them once the tables exist.

## Consequences

- Aggregate metrics come from one table: AI latency, failure rate, cost per workflow and
  validation pass rate.
- Debugging a bad output relies on sources, structured output and versions rather than
  raw transcripts.
