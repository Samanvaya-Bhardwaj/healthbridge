# ADR-0006: Layered access control: RBAC, relationship, consent, with RLS and least-privilege roles

- **Status:** Accepted (database roles in place in M0; policies arrive from M1/M2)
- **Date:** 2026-10-01

## Context

Broken access control is the most likely serious defect class in a medical-records
system. Being authenticated must never be enough to see patient data.

## Decision

Every access to patient data must pass **three gates**:

1. **Role permission (RBAC).** Can this role perform this kind of action?
2. **Resource relationship.** Is this specific resource related to this actor (own record,
   guardian, treating doctor, clinic membership)?
3. **Active consent.** Does an active, unexpired, unrevoked consent cover this patient,
   data category and purpose? It is evaluated **at request time**, with no long-lived cache.

Implementation:

- `AccessPolicy` is the **central authorisation service** for patient-data access. Every
  PHI read goes through it.
- **Defence in depth.** The application layer is not the only control:
  - Runtime database roles are least-privilege. They are not superusers, cannot bypass
    RLS, cannot run DDL, and the audit schema is append-only for them.
  - **PostgreSQL row-level security** policies are applied to patient-scoped tables,
    keyed by session settings set per transaction.
  - The AI service's role has no access to core tables.
- Resources outside the actor's scope return **404, not 403**, so their existence is not
  revealed.
- **Every sensitive read and write produces an audit event** (`audit.audit_logs`,
  `audit.record_access_logs`), including denied attempts.

## Consequences

- A bug in one layer does not by itself expose another patient's data.
- RLS requires every transaction to set its actor context. Repository helpers enforce
  this.
- An authorisation test matrix (patient A ≠ patient B, unrelated doctor, revoked consent,
  expired URLs, AI retrieval scope) runs on every PR.
