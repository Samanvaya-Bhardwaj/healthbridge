# ADR-0004: AI proposes, backend validates, backend commits

- **Status:** Accepted
- **Date:** 2026-10-01

## Context

AI output can be wrong, incomplete or manipulated (for example by prompt injection inside
an uploaded document). Clinical records carry medico-legal weight.

## Decision

The invariant is: **AI proposes → backend validates → backend commits.**

- AI must **never directly modify** any of the following:
  - prescriptions;
  - clinical notes;
  - diagnoses;
  - appointments;
  - consent;
  - patient medical records.
- Everything the AI produces is first stored as an **AI artifact or proposal** in the
  `ai` schema. Each one records:
  - its source references;
  - its confidence or validation state, where applicable;
  - the model and provider;
  - a timestamp;
  - the request ID and run ID.
- Only a backend workflow can turn a proposal into authoritative data. That workflow
  applies domain validation, authorisation, a transaction and an audit event. Clinically
  meaningful promotion requires a human: for example, a doctor verifying extracted lab
  values.
- This is enforced at the database level as well. The AI service's role has privileges
  on the `ai` schema only and no access to core clinical tables (verified by an
  integration test).

## Consequences

- AI-derived data is always distinguishable from clinician-entered data. The UI shows
  provenance badges.
- Re-running AI (with a better model or prompt) creates new artifacts. Previously committed
  data is never silently rewritten.
- Promotion workflows add steps, which is the intended human-in-the-loop cost.
