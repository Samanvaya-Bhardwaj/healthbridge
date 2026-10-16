# ADR-0037: Local models through Ollama

- **Status:** Accepted (implemented)
- **Date:** 2026-10-16
- **Builds on:** ADR-0007 (provider abstractions), ADR-0008 (LLM use and PHI policy),
  ADR-0022 (document intelligence and embeddings), ADR-0036 (spend ceiling).

## Context

Every AI workflow ran either on the deterministic fake model (development, tests, CI) or
on Claude, an external provider that production refuses without the ADR-0008 approval.
That left no way to try the AI features with a real model while keeping records on the
machine. A self-hosted model removes the external-processing question, because nothing
leaves the operator's infrastructure.

## Decision

- **Chat models:** `LLM_PROVIDER=ollama` uses Ollama's chat API.
  - The model names come from `LLM_MODEL_DEFAULT` and `LLM_MODEL_FAST`, and the server
    from `OLLAMA_BASE_URL` (by default `host.docker.internal:11434`, Ollama on the host).
  - Structured output uses Ollama's `format` with the same JSON schema; every workflow
    still validates what comes back.
  - Temperature is 0. Models stay loaded (`keep_alive`), so the fixed prompt prefix is
    reused between turns.
- **Embeddings:** `EMBEDDING_PROVIDER=ollama` with `OLLAMA_EMBED_MODEL` (default
  `nomic-embed-text`).
  - Vectors are L2-normalised and zero-padded to the 1024-dimension columns; padding
    changes no cosine similarity.
- **One embedding space per comparison:**
  - Each document chunk now records its `embedding_model`, and retrieval compares
    vectors only within the current model. Full-text ranking still covers chunks of any
    model.
  - The doctor-search index re-embeds profiles whose stored model differs from the
    current one (`GET /v1/embeddings/model`) and ranks only by vectors of the query's
    model.
- **Self-hosted is not external:** `ollama` is not in the external-provider set. It needs
  neither `LLM_EXTERNAL_PROCESSING_APPROVED` nor `LLM_DAILY_BUDGET_USD` (estimated cost 0),
  and the deployment preflight warns that it must run on infrastructure the operator
  controls.
- **Slow models:** `AI_SERVICE_TIMEOUT_SCALE` multiplies the backend's AI timeouts, and
  the edge allows API requests up to 300 s.
- **Small models misread explicit words**, such as treating "Monday" as today. Code reads
  the unambiguous ones in the message and corrects the form: weekday, today, tomorrow,
  online, in clinic, morning, afternoon and evening. Negations and "either" are left alone.
  The model keeps everything else (kind of doctor, areas, names, corrections).

## Consequences

- The assistant, document extraction, briefs and record questions work with records
  staying on the laptop. Quality and speed depend on the model: a 3B model on a CPU
  answers in about 10–40 s.
- Tests, evaluations and CI keep the deterministic fake model, so results don't depend on
  a model.
- After switching embedding providers, documents analysed earlier stay findable through
  full-text ranking. Re-analysing them (a new prompt version, or uploading again) gives
  them vectors in the new space.
