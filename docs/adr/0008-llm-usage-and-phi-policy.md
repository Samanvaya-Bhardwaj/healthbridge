# ADR-0008: LLM usage and PHI policy

- **Status:** Accepted
- **Date:** 2026-10-01

## Context

Sending health data to an external LLM provider raises privacy, contractual, residency and
regulatory questions. These include India's DPDP Act, 2023 and its Rules, and any
applicable healthcare requirements. Removing names or IDs does **not** make medical
content safe to share: clinical details can re-identify people and remain sensitive on
their own.

## Decision

**Development**

- Claude (Anthropic API) is the initial provider. It is reached only through the
  `LLMProvider` abstraction (ADR-0007), so the application is not coupled to it.
- Only **synthetic** medical data is used. Real patient data or PHI is never used in
  development, demos, tests or CI.
- API keys are supplied through environment variables only. Tests and CI use the
  deterministic `FakeLLMProvider` and never call paid APIs.

**Logging**

- AI telemetry logs **metadata only**:
  - workflow;
  - provider;
  - requested model and the model that served the request;
  - latency;
  - token usage;
  - estimated cost;
  - stop reason;
  - run ID and request ID;
  - error kind.
- Prompts, outputs, document text and other medical content are **never logged**.
  Third-party loggers that can emit request bodies (`anthropic`, `httpx`, `httpx2`,
  `httpcore`) are pinned to `WARNING`. Tests assert that synthetic markers in prompts and
  outputs do not appear in logs.

**Production**

- The provider and models are configurable (`LLM_PROVIDER`, `LLM_MODEL_*`).
- Production use with real patient data requires an explicit privacy, security and
  compliance review, plus appropriate contractual and provider controls. Examples include
  a data processing agreement, retention terms, regional processing where required, and
  provider security attestations.
- **Enforced in code:** with `APP_ENV=production`, the AI service refuses to start with an
  external LLM provider unless `LLM_EXTERNAL_PROCESSING_APPROVED=true` is set. This flag
  must be set only after that review. The fake provider is also refused in production.
- Self-hosted models remain an option behind the same interface.
- Server-side refusal fallback (`LLM_REFUSAL_FALLBACK`) is enabled for supported Claude
  models. The model that actually served each request is recorded, so a fallback is always
  visible in telemetry and AI run records.

## Consequences

- Development can move fast on synthetic data without creating compliance exposure.
- Going live with real data is a deliberate, reviewable decision rather than a config
  accident.
- No legal or compliance claims are made by this ADR. It records engineering controls only.
