# Security model

Status: M2 (identity, sessions, RBAC, audit, patient-scoped authorization, RLS). This document describes the controls that
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
- Account lockout can be abused to block a known account temporarily (bounded at 15
  minutes).

## Patient-scoped authorization (M2, ADR-0017)

### Authorization matrix: who can do what to a patient profile

| Actor | Read profile | Update profile | Manage care team | Notes |
|---|---|---|---|---|
| The patient (`patient_self`) | ✅ | ✅ | ✅ | |
| Guardian, scope `manage` (`guardian_dependent`) | ✅ | ✅ | ✅ | Created dependents; explicit relationship type and basis |
| Guardian, scope `view` | ✅ | ❌ (404) | ❌ (404) | Model supported; delegation UX later |
| Doctor with ACTIVE care relationship (`treating_doctor`) | ✅ (consent basis: active care relationship) | ❌ (403, no permission) | Own side only (accept, decline, end) | Doctor must be verified and active, and the user active |
| Doctor with pending, invited, paused or ended relationship | ❌ (404) | ❌ | Own side of that relationship | |
| Unrelated doctor or patient | ❌ (404) | ❌ (404) | ❌ (404) | Indistinguishable from a non-existent ID |
| Clinic admin or clinic member | ❌ (403, no `patients:read`; app layer: no consent; RLS: invisible) | ❌ | ❌ | Membership never grants patient access |
| Platform admin, support | ❌ (403, no `patients:*`) | ❌ | ❌ | Administrative ≠ clinical access |
| Any doctor, `medical_records:*` | ❌ (403 `consent_required`) | — | — | Until M5 consent management |
| Anonymous, disabled user, revoked session | ❌ (401) | ❌ | ❌ | |

### Clinic scope

| Actor | Clinic A members | Clinic B members | Invite doctor to A |
|---|---|---|---|
| Clinic admin of A | ✅ | ❌ (403) | ✅ (verified doctors only) |
| Platform admin (`admin:clinics`) | ✅ | ✅ | ✅ |
| Doctor member of A | ❌ | ❌ | ❌ |

### Defence in depth

1. **Gate 1 (RBAC):** route permission plus the clinic in scope.
2. **Gate 2 (relationship):** `modules/care-access`, independent application SQL.
3. **Gate 3 (consent):** interim resolver; M5 replaces it with consent records.
4. **PostgreSQL RLS** on `patients`, `patient_guardianships` and `care_relationships`,
   keyed on a transaction-local `app.user_id`. No DELETE policies. The app role cannot
   bypass RLS.
5. **Audit:** all patient-data decisions (allowed and denied), plus profile, dependent,
   care-relationship, verification and clinic events. Field names only, never values.
   Reviewer notes are never audited.

Each layer is tested on its own:
- `rls.test.js` uses raw SQL only;
- `careAndAccess.test.js` runs the application layer with RLS bypassed;
- the adversarial API suite covers both layers together.

### Doctor verification and roles (ADR-0018)

- `DOCTOR` is granted only by an approved verification and removed on suspension.
- `CLINIC_ADMIN` is granted only by clinic appointment.
- Both are refused by the generic role endpoint and by provisioning.
- Nobody can review their own verification.

## Scheduling (M3, ADR-0019)

| Actor | Book | View appointment | Reason for visit | Cancel | Check-in | Complete / no-show |
|---|---|---|---|---|---|---|
| Patient / managing guardian | ✅ with an ACTIVE care relationship | ✅ | ✅ | ✅ before the start | ❌ | ❌ |
| Doctor of the appointment | ❌ | ✅ (patient identity via AccessPolicy) | ✅ (audited) | ✅ | ✅ in-clinic | ✅ |
| Clinic admin of the appointment's clinic | ❌ | ✅ booking reference only | ❌ (RLS) | ✅ | ✅ | No-show only |
| Unrelated patient or doctor | ❌ (404) | ❌ (404) | ❌ | ❌ | ❌ | ❌ |
| Treating doctor listing a patient's other appointments | — | ❌ (403 `consent_required`) | — | — | — | — |
| Platform admin, support | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

- No double booking is enforced by PostgreSQL `EXCLUDE` constraints, which hold under
  concurrency.
- Idempotency keys make booking retries safe.
- Busy-time lookups expose time ranges only.
- Outbox payloads carry identifiers only, never reasons.
- The doctor directory (`GET /doctors`, `GET /doctors/:id`) accepts a `doctors:read` grant
  in any clinic scope (`requirePermission(..., { anyScope: true })`), so staff clinic
  admins can find doctors to invite. The option is reserved for non-patient reference
  data; patient routes always evaluate clinic scope against the resource.
