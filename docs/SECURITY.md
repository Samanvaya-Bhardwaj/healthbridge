# Security model

Status: M1 (identity, sessions, RBAC, audit). This document describes the controls that
exist in the code today. Planned controls are labelled as such. It is not a compliance
statement (see ADR-0008).

## Identity and sessions (ADR-0015)

| Control | Implementation |
|---|---|
| Password storage | Argon2id (m=19 MiB, t=2, p=1), NFKC-normalised, rehash on login when parameters increase. Plaintext is never stored, logged or returned. |
| Password policy | 12–128 characters, common-password deny-list, must not contain the email local part or name. Shared length rules on client and server. |
| Access tokens | Ed25519 JWT, 10 minutes, identifiers only, in memory only in the SPA. Verification pins `alg`, `typ`, `iss`, `aud` and required claims. |
| Session validation | Every request re-checks the session (revoked/expired), account status, roles and permissions in the database. |
| Refresh tokens | 256-bit random, `httpOnly` + `SameSite=Strict` cookie scoped to `/api/v1/auth`, `Secure` required outside dev, stored only as SHA-256, rotated on each use, replay detection revokes the session |
| Session lifetimes | Patients 3 days idle / 14 days absolute. Staff roles 12 hours idle / 3 days absolute. |
| Revocation | Logout, per-session revoke, "sign out others", password change (other sessions), account disable (all sessions), admin revoke |
| CSRF | SameSite=Strict + Origin/Referer allowlist + double-submit header + server-side synchronizer hash |
| Enumeration | Identical responses for registration (new/existing) and login failures, timing equalised with a dummy hash |
| Brute force | Lock for 15 minutes after 5 failures. Redis rate limits per IP, per account (hashed email key) and per user, plus a global per-IP limit. |
| Caching | `Cache-Control: no-store` on token and account responses |

## Authorization (ADR-0006)

1. **Role → permission (RBAC).** Permissions are explicit
   (`shared/src/auth/permissions.js`) and assigned to roles in the database. A startup
   check and a test fail if the code and database catalogs drift. Routes declare
   `accessPolicy.requirePermission(...)`; controllers never check role names.
2. **Resource relationship.** `AccessPolicy.enforce({ principal, permission, resource })`
   asks a registered resolver whether this principal is related to this resource.
   - Resolvers in M1: `session` (owner).
   - Coming in M2: patient self, guardian, treating doctor, clinic membership.
   - An unknown type or a resolver error **denies**. A denial returns 404 so existence
     is not revealed.
3. **Active consent.** For resources carrying `patientId`, a consent resolver must find
   an active consent unless the relationship is `self` or `guardian`. Until the consent
   module exists (M5), the default resolver **denies**.

Role intent: platform admins and support have **no clinical-record permissions**. Only
doctors can sign prescriptions. Only platform admins read audit logs or change roles.
Public registration only ever creates PATIENT accounts.

## Audit (ADR-0016)

- `audit.audit_logs` is append-only: the app role has SELECT/INSERT only, and triggers
  reject UPDATE/DELETE/TRUNCATE.
- Audited events:
  - all authentication events;
  - all authorisation denials (with endpoint);
  - account and admin changes;
  - admin reads;
  - audit-log reads;
  - patient-data decisions (from M2).
- Successful sensitive actions are audited inside the business transaction.
- Metadata is sanitised: secret-like keys are redacted and sizes are bounded. Free text
  is not recorded.

## Logging hygiene

- Request logs contain method, path (no query string), status, duration and request ID.
- Authorization, cookie and set-cookie headers are redacted.
- Tests assert that passwords, access tokens, refresh secrets, CSRF tokens and Argon2
  hashes never appear in logs or API responses.

## Known gaps / planned

- MFA (TOTP) for staff roles: Phase 2.
- Email verification and password reset: later milestone.
- Breached-password checks (k-anonymity).
- Lock-event alerting.
- Audit hash chaining and external immutable storage: Phase 2.
- Redis cache for per-request principal loading, if load requires it.
- Row-level security policies on patient tables arrive with those tables (M2).
- Account lockout can be abused to block a known account temporarily (bounded at 15
  minutes).
