# ADR-0009: Immutable signed clinical records with explicit versioning

- **Status:** Accepted (implemented with consultations and prescribing)
- **Date:** 2026-10-01

## Context

Prescriptions and clinical notes are medico-legal records. Silent edits destroy trust and
auditability.

## Decision

- Once **signed**, a prescription or clinical note is immutable. The application never
  issues an `UPDATE` to its clinical content.
- Corrections follow **original → correction (new version) → new authoritative version**:
  - the new row has `version = n + 1` and `supersedes_id` pointing to the prior version;
  - the prior version's status becomes `superseded`. Only that status transition is allowed;
  - a correction reason and the author are required, and an audit event is written.
- Clinical records are never hard-deleted.
- The patient and the doctor can see the full version history.
- This is enforced in the domain layer and backed by database triggers that reject
  content updates on signed rows.

## Consequences

- A complete, inspectable history of every clinical decision.
- Reads must select the current (non-superseded) version. Repository helpers and views
  handle this.
