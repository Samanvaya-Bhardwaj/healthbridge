# ADR-0011: Bounded, workflow-defined agents

- **Status:** Accepted (implemented from M6)
- **Date:** 2026-10-01

## Context

Open-ended autonomous agents are hard to audit and constrain. HealthBridge's AI tasks are
known workflows, not open exploration.

## Decision

- Agents are **predefined workflows**, implemented as explicit LangGraph state graphs with
  checkpointing. Steps are deterministic wherever possible, and LLM calls appear only
  where language understanding is required.
  - **Document agent:** classify → extract → validate → store AI artifact.
  - **Pre-consultation agent:** retrieve authorised records → summarise → generate doctor
    brief → cite sources.
  - **Follow-up agent:** schedule reminder → collect patient response → summarise response
    → escalate to the doctor when rules require it.
- Each agent has a fixed list of allowed actions and data scope. Extraction and
  summarisation nodes have **no tools**, so instructions embedded in documents cannot
  trigger actions.
- There is **no generic autonomous medical agent**. AI never diagnoses, prescribes, alters
  treatment, makes emergency decisions, or contacts patients on its own.
- Escalation in follow-ups is decided by deterministic rules plus the doctor. The LLM only
  summarises.

## Consequences

- Every agent run is reproducible and inspectable step by step.
- New capabilities require explicitly designing a new workflow. That limit is deliberate.
