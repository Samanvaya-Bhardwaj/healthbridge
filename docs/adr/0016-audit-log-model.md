# ADR-0016: Audit log model — single append-only table

- **Status:** Accepted (implemented in M1)
- **Date:** 2026-10-01
- **Refines:** proposal §3.4 (`audit_logs` and `record_access_logs`)

## Context

The proposal sketched two tables, `audit.audit_logs` and `audit.record_access_logs`.
Both carry the same envelope (actor, action, outcome, resource, request metadata). The
patient question "who accessed my records?" is a filter by patient, not a separate
structure.

## Decision

- One table, **`audit.audit_logs`**, with a `category` column: `authentication`,
  `authorization`, `account`, `administration`, `data_access` or `system`. Patient-data
  decisions use `category = 'data_access'` with an indexed `patient_id`.
  `record_access_logs` is not created. A view can provide it later if useful.
- Each row records:
  - `occurred_at`;
  - `action` (e.g. `auth.login`, `admin.user_role_grant`, or the permission for
    authorisation decisions);
  - `outcome` (`success`, `failure` or `denied`) and a machine-readable `reason`;
  - the actor (`actor_type`, `actor_user_id`, `actor_roles`, `session_id`);
  - the resource (`resource_type`, `resource_id`, `patient_id`);
  - `request_id`, `ip` and `user_agent`;
  - sanitised `metadata`, which is size-limited and has secret-like keys redacted.
- **Append-only** at three levels:
  1. The application role holds only `SELECT` and `INSERT`.
  2. Triggers reject `UPDATE`, `DELETE` and `TRUNCATE` for any role.
  3. There is no FK to `users`, so audit rows never block or cascade with account changes.
- **What is audited.**
  - Every authentication event: register, login success and failure, refresh denial and
    reuse, logout, token use against a dead session.
  - Every authorisation **denial**, including the endpoint.
  - Every account and administration change.
  - Administrative reads of other users' data.
  - Reads of the audit log itself.
  - Every patient-data access decision, allowed or denied (from M2).
- **Write semantics.** Successful sensitive actions write their audit row in the **same
  transaction** as the change (fail closed). Denials are written best-effort: a denial is
  always enforced even if the audit write fails, and that failure is logged.
- **Never in audit rows:** passwords, tokens, hashes, cookies, free-text reasons, or
  medical content. Search terms are recorded as `hasQuery: true` only.
- **Not partitioned yet.** A BRIN index on `occurred_at` plus B-tree indexes on actor,
  action, resource, patient and request ID. Convert to monthly range partitions when
  volume warrants it, together with a retention policy decided with legal review.

## Consequences

- A single place to query security events, joinable by `request_id` with application
  logs.
- Tamper-evidence (hash chaining) and shipping to external immutable storage remain
  Phase 2 items.
