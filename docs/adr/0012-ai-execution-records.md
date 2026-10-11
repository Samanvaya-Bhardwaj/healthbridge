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
| `prompt_version`, `input_hash` | reproducibility without storing the input (keyed for free text; see below) |
| `input_digest_key_id` | the backend key that produced a keyed `input_hash` |

- **Raw prompts and responses are not stored unnecessarily.** We store hashes, prompt
  template versions, structured validated outputs (the AI artifact) and source
  references.
### Input digests (M13.1 review)

`input_hash` is **telemetry**: it shows that two runs had the same input without storing
it. Nothing reads it to make a decision (no deduplication, no caching, no access control).

| Workflow | Input | Digest | Why |
|---|---|---|---|
| `care_assistant` | the person's message | HMAC-SHA256, backend key, with `input_digest_key_id` | free text |
| `record_question` | the question | HMAC-SHA256, backend key, with `input_digest_key_id` | free text |
| `follow_up_summary` | follow-up ID and fact texts (incl. the patient's note) | HMAC-SHA256, backend key, with `input_digest_key_id` | free text |
| `doctor_brief` | appointment, document and fact **IDs** | plain SHA-256 | identifiers only; reveals nothing new |
| document analysis (`document_extractions.input_sha256`) | the file's SHA-256 and document type | plain SHA-256 | **deduplication** of re-analysis; the file hash is already stored with the document |

- **Key:** `AI_INPUT_DIGEST_KEY`, a dedicated backend-only secret (not the clinical data
  key, not the internal service secret). The AI service never receives it: the backend
  sends `{ keyId, value }` and the AI service stores both.
- **Purpose and version:** each workflow has its own subkey (HKDF label
  `ai-input-digest/<purpose>/v1`). The stored key ID names the key; a scheme change needs a
  new key ID.
- **Rotation:** a new key gives new digests, so runs before and after a rotation can't be
  compared. That is acceptable for all three workflows: the digest is telemetry only.
- **Enforced:** a constraint refuses a digest for a free-text workflow without a key ID.
  Earlier plain SHA-256 digests of free text were cleared by the migration
  `20261013000002_ai_input_digest_keys`.

- In M0 the `InstrumentedLLMProvider` emits these fields as structured `llm_call` log
  events. The same hook persists them once the tables exist.

## Consequences

- Aggregate metrics come from one table: AI latency, failure rate, cost per workflow and
  validation pass rate.
- Debugging a bad output relies on sources, structured output and versions rather than
  raw transcripts.
