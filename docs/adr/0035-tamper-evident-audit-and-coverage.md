# ADR-0035: Tamper-evident audit log and audit coverage (step 9)

- **Status:** Accepted (implemented)
- **Date:** 2026-10-15
- **Builds on:** ADR-0006 (layered access control), ADR-0016 (audit log model),
  ADR-0021 (consent and documents), ADR-0025 (immutable clinical records).

## Context

`audit.audit_logs` is append-only for the application: the app role holds SELECT/INSERT
only, and triggers reject UPDATE, DELETE and TRUNCATE. Two gaps remained, both listed as
residual risks in the M11 security review:

1. **No tamper evidence.** Someone with database-owner access can switch the triggers off
   and change or delete entries, leaving no trace. Owner access is exactly what a database
   breach, a stolen backup or an insider with infrastructure rights gives.
2. **No proof of coverage.** Sensitive actions were audited by convention, service by
   service. Nothing failed when a new endpoint forgot to audit.

## Decision

### 1. A keyed hash chain over consecutive ranges (`audit.audit_seals`)

- A worker job (`audit-seal`, every 5 minutes) seals the next range of the log:
  - `[sealed_from, sealed_to)`. The first seal starts at the epoch; each later one starts
    exactly where the previous one ended (a trigger enforces this), so every moment is
    covered by exactly one seal.
  - Only ranges older than **10 minutes** are sealed. Statements time out after 15 s and
    idle transactions after 30 s, so no row can still commit into a sealed range.
  - A seal records the row count, a SHA-256 over the rows in `(occurred_at, id)` order and
    an HMAC-SHA256 over `(previous HMAC, seq, bounds, count, SHA-256)`.
  - Rows are hashed in a canonical text form: UTC timestamps to the microsecond and
    PostgreSQL's own text output for uuid, inet, arrays and jsonb.
  - Backlogs are sealed in pieces of about 20,000 rows. An idle log still gets an hourly
    seal, so the chain stays current.
  - Each new seal's chain value is also written to the structured log, so a copy of the
    chain lives outside the database.
- The HMAC key is derived (HKDF, `audit-log-seal`) from the clinical data key ring. That
  key ring already exists, is mandatory in staging and production, and never reaches the
  database. The prescription seal uses the same pattern.
- **Verification** recomputes seals in order and reports the first that fails:
  - `rows_changed`: an entry in the range was changed, added (back-dated) or removed;
  - `seal_altered`: the seal row no longer matches its HMAC;
  - `seal_missing`: the chain has a gap;
  - `key_unavailable`: the key ID that made the seal is not configured.
- **Where it runs:**
  - `npm run audit:verify -w backend` checks the whole chain and exits non-zero on failure.
  - Admin → Audit log → **Check integrity** (`GET /admin/audit-integrity`, `audit:read`)
    checks the 96 most recent seals on request. Every check is itself audited
    (`audit.integrity_checked`).
  - A failure increments `healthbridge_audit_seal_verification_failures_total{problem}`.
- `audit.audit_seals` is append-only in the same way as the log.

### 2. Audit coverage enforced by the integration suite

- The test harness records every successful state-changing request (POST, PUT, PATCH or
  DELETE answering 2xx) in every integration test file.
- When the file closes, the harness fails if any of those requests left no audit row with
  its request ID.
- The exceptions are listed in `backend/tests/integration/auditCoverage.js`, each with its
  reason, and a test keeps that list pointing at real routes:
  - **Never audited:** client error reports, routine token refresh (every refused refresh
    and token reuse *is* audited), marking your own notifications read, and the
    waiting-room heartbeat.
  - **Audited when something changes:** checkout reopened for the same payment, a refund
    retried with the same idempotency key, starting an already-live consultation, and
    asking to verify an address that is already confirmed.
  - **Ledger instead of audit:** payment webhooks are stored in `payment_events` with
    their request ID.
- The first run found one real gap: ending an assistant conversation was not audited,
  although starting one was. It now records `assistant.session_ended` (turn count only).

## Consequences

- Changing, deleting or back-dating an entry in a sealed range, or editing a seal, is
  detected without the key. Forging a consistent chain needs the clinical data key as well
  as owner access to the database.
- **Not covered** (documented in SECURITY.md):
  - the newest 10–15 minutes, which are not sealed yet;
  - an attacker holding *both* database-owner access and the application key, who could
    rebuild the chain. The chain values copied to the log stream are the cross-check;
    external, write-once storage of seals is the Phase 2 step.
  - Truncating the newest seals together with their rows shortens the chain without
    breaking it. Compare the latest seal with the last `audit range sealed` log line.
- Rotating `CLINICAL_DATA_KEY` keeps working: each seal stores its key ID, and old keys
  stay in `CLINICAL_DATA_PREVIOUS_KEYS`, which records already require.
- Sealing adds one index on `(occurred_at, id)` and a small periodic job; inserts are not
  serialised.
- A new endpoint that forgets to audit fails the integration suite the first time a test
  calls it.

## Alternatives considered

- **A per-row chain** (each row hashes the previous one): serialises every audit insert
  across the system, behind one lock or a trigger. Rejected for throughput and
  deadlock risk.
- **pgaudit or log shipping only:** useful for infrastructure, but it doesn't make the
  application's own record tamper-evident, and it isn't portable to the single-host
  deployment.
- **A new dedicated secret:** possible, but it adds a production secret and a rotation
  procedure for little gain over a key derived from an existing mandatory one.
