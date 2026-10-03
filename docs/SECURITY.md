# Security model

Status: M11 (all Phase 1 controls; see also the OWASP review in [SECURITY_REVIEW.md](SECURITY_REVIEW.md)). This document describes the controls that
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

- **Signed URLs cannot be revoked retroactively (M5).** Revoking consent stops every new
  request and every new URL immediately. A presigned download URL issued *before* the
  revocation remains usable until its short expiry: by default 60 s, at most 300 s
  (`DOCUMENT_DOWNLOAD_URL_TTL_SECONDS`). Object storage cannot recall a signature it has
  already issued. We therefore:
  - keep TTLs short;
  - never issue long-lived or permanent URLs;
  - authorise before signing.

  We do not claim retroactive invalidation.
- The fake document scanner provides **no malware protection**. It is refused in staging
  and production; ClamAV is the supported scanner.
- Quarantine objects from abandoned upload intents need a bucket lifecycle rule in
  production.

- Payments: no reconciliation job yet. `getPaymentStatus` exists but is not used for
  automatic correction; the webhook stays the only authority.
- Rescheduling a paid appointment refunds the old payment in full and asks for a new one
  (no carry-over).
- SMS has no real provider yet (the fake records messages only).

- MFA (TOTP) for staff roles: Phase 2.
- Email verification and password reset: delivered in M11 (see below).
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

## Payments, webhooks and workers (M4, ADR-0020)

| Actor | Start checkout | Payment details (amount, refunds) | Payment status | Issue refund | Mark paid |
|---|---|---|---|---|---|
| Patient / managing guardian | ✅ own appointments (empty body; server amount) | ✅ | ✅ | ❌ (403) | ❌ |
| View-only guardian | ❌ | ✅ | ✅ | ❌ | ❌ |
| Doctor of the appointment | ❌ | ❌ (403) | ✅ status only | ✅ goodwill/duplicate, ≤ amount paid | ❌ |
| Clinic admin of the appointment's clinic | ❌ | ❌ | ✅ status only | ✅ | ❌ |
| Other clinic's admin | ❌ | ❌ | ❌ | ❌ (403, clinic-scoped gate 1) | ❌ |
| Unrelated patient or doctor | ❌ (404) | ❌ (404) | ❌ | ❌ | ❌ |
| Platform admin / support | ❌ | ❌ (403) | ❌ | ❌ | ❌ |
| Platform admin (`operations:manage`) | Dead letters and queue health: identifiers and failure reasons only | | | | |
| **Verified provider webhook** | — | — | — | — | ✅ **the only path** |

- **Webhook verification:**
  - HMAC-SHA256 over the raw body, compared in constant time.
  - Unsigned, mis-signed or malformed bodies get 400, a `payment.webhook_invalid` audit
    row and a metric.
  - Duplicates and replays are no-ops (unique event ID and payload digest).
  - Unknown orders, amount or currency mismatches, wrong references and reused provider
    payment IDs are recorded as rejected and audited.
  - The raw body is never stored: it can contain the payer's contact details.
- **Never trusted:** frontend success callbacks, client-supplied amounts and the
  Checkout handler's signature.
- **Refunds:**
  - they require an `Idempotency-Key`;
  - they are capped at the amount paid, under a row lock;
  - only the provider's `refund.processed` webhook writes the ledger debit.
- **Secrets:**
  - `PAYMENT_WEBHOOK_SECRET` and `RAZORPAY_KEY_SECRET` come from the environment only.
  - Configuration refuses the fake provider in production and live keys elsewhere.
  - The browser receives only the public key ID and the order ID.
- **Audit:**
  - Category `financial` covers payment creation, capture, failure, cancellation, late
    capture, refund request, processing and failure, and invalid, duplicate or rejected
    webhooks.
  - `appointment.confirm_payment` and `appointment.expire` are recorded under
    `data_access` with actor `system`.
- **Data minimisation:**
  - Outbox payloads, Redis jobs, dead letters and notification templates carry
    identifiers, schedule and amount only — never the reason for visit.
  - Logs record template, channel and event type, never addresses or bodies.
- **Nginx CSP** allows only `checkout.razorpay.com` (script), `api.razorpay.com` (frame,
  connect), `lumberjack.razorpay.com` (connect) and `cdn.razorpay.com` (images). COOP is
  `same-origin-allow-popups` for bank and UPI pop-ups.

## Consent and medical documents (M5, ADR-0021)

| Actor | View documents | Download | Upload | Grant / revoke consent | Access log |
|---|---|---|---|---|---|
| Patient | ✅ all own (any state) | ✅ available | ✅ | ✅ | ✅ |
| Managing guardian | ✅ dependent's | ✅ | ✅ | ✅ for the dependent | ✅ |
| View-only guardian | ✅ dependent's | ✅ | ❌ | ❌ (404) | ✅ |
| Treating doctor with active `medical_documents` consent | ✅ available documents of consented types only | ✅ (≤ 60 s URL) | only with `medical_documents_upload` | ❌ | ❌ |
| Treating doctor without consent, or with expired, revoked or out-of-scope consent | ❌ 403 `consent_required` | ❌ | ❌ | ❌ | ❌ |
| Doctor with no relationship, including a doctor at another clinic | ❌ 404 | ❌ | ❌ | ❌ | ❌ |
| Clinic admin | ❌ 403 (no permission) | ❌ | ❌ | ❌ | ❌ |
| Platform admin, support | ❌ 403 | ❌ | ❌ | ❌ | ❌ |
| Another patient (guessed IDs) | ❌ 404, identical to a missing document | ❌ | ❌ | ❌ | ❌ |

- **Request-time consent:**
  - Gate 3 queries `consents` on every request.
  - RLS independently requires `authz.has_consent()` for non-patient readers.
  - Appointment-scoped consent ends when its appointment is cancelled, expired or a
    no-show.
- **No unscanned file is ever available:**
  - `AVAILABLE` requires a scanner verdict, verified SHA-256 and a detected content type
    (CHECK constraint);
  - only the `documents` system context can change status;
  - the transition trigger blocks shortcuts.
- **Uploads:**
  - The type allowlist (PDF, PNG, JPEG) is checked against the extension and magic bytes.
  - Size is enforced three times: in the API, by the storage POST policy, and in the
    worker.
  - The client-declared SHA-256 is verified.
  - Filenames are display-only and sanitised for `Content-Disposition`; keys are random and
    server-generated.
- **Storage:**
  - The bucket is private.
  - The browser gets only presigned requests, never credentials or permanent URLs.
  - Nginx exposes only GET/HEAD/POST on the bucket path, over a network that MinIO shares
    with Nginx alone.
- **Audit events:**
  - consents: `consent.granted`, `revoked`, `expired`;
  - documents: `document.upload_intent_created`, `upload_completed`, `scan_started`,
    `scan_failed`, `scan_rejected`, `promoted`, `viewed`, `list_viewed`,
    `download_authorized`, `access_denied`, `retired`.
  - Signed URLs, keys, contents and tokens are never recorded.
- **Notifications** use generic wording only ("Your document is ready"), never the
  document's name, type or contents.

## Document intelligence (M6, ADR-0022)

- **Opt-in:** AI reads a patient's documents only after the patient or a managing guardian
  switches processing on (audited). Switching it off stops new analysis.
- **Least privilege:**
  - The AI service never reads MinIO or core tables (it has no grants).
  - It receives one document at a time with a backend-signed patient-scope token
    (120 s; patient, document IDs and purpose).
  - Its database transactions are RLS-confined to that patient.
  - Database tests prove that one scope cannot read or write another patient's artifacts
    and that the role cannot delete AI history.
- **Prompt injection:**
  - Document text is delimited data under explicit system rules.
  - Agent nodes have no tools.
  - Instruction-like text is flagged and the extraction marked for clinician review.
  - Values are kept only when quoted verbatim from the source.
- **No AI writes to the record:** proposals stay in `ai`. Lab values enter the record only
  when a consented treating doctor verifies them. Values are copied server-side; clients
  send only keys.
- **Logging:** logs and `ai_runs` hold metadata only — counts, flags, tokens, cost,
  prompt version and input hash — never text, quotes or values.

## Medical timeline (M7, ADR-0023)

- The timeline is part of the medical record: `medical_records:read` plus consent.
- RLS repeats the scope per event: a doctor sees only the document types their consent
  covers, and only their own appointments.
- Provenance is always shown. AI-derived dates and issuers are labelled, and unverified AI
  values never appear.
- Export is limited to the patient side and audited. The access log shows
  `timeline.viewed` and `timeline.exported`.

## Doctor brief and record questions (M8, ADR-0024)

- **Who:** a treating doctor with `ai_assist:use` and an active `medical_documents`
  consent, for a patient who opted in. Briefs are only for the doctor's own appointment.
- **What the AI sees:** only the RLS-visible documents (the consented types) and verified
  lab values, named in a scope token. The AI service refuses anything else, and retrieval
  SQL is limited to those documents under patient-scoped RLS.
- **What leaves:** cited sentences only. Unknown citations, numbers absent from the
  sources, unsupported wording and diagnostic or treatment language are removed. With
  nothing left, the answer is exactly "Insufficient information. Please consult the
  doctor."
- **Privacy:** question text is never stored, logged or audited; only counts and a hash
  are kept. Briefs are visible to their doctor only while consent lasts.
- **Rate limit:** 60 AI calls per doctor per hour.

## Consultations and prescribing (M9, ADR-0025)

- **Who writes:**
  - Only the consulting doctor starts a consultation, writes and signs notes and
    prescriptions, and records the outcome (`consultations:conduct`,
    `prescriptions:sign`).
  - The system never decides an outcome. Emergency escalation is doctor-confirmed and
    flagged in the audit log, and the patient sees fixed guidance (112 / 108).
- **Immutability:**
  - Signed notes and prescriptions cannot be updated or deleted; database triggers
    back the application rules.
  - Corrections are new signed versions with a reason.
  - `DELETE` is revoked from the application role.
- **Integrity:**
  - Prescriptions carry a SHA-256 of their canonical content and an HMAC seal.
  - The PDF renderer verifies both and refuses tampered content.
  - The PDF hash is recorded, and the PDF is rendered once.
- **Confidentiality:**
  - SOAP notes are envelope-encrypted (AES-256-GCM, a per-note data key, a key ID for
    rotation, and associated data bound to the note and patient).
  - `CLINICAL_DATA_KEY` is mandatory in staging and production.
  - Other doctors see signed prescriptions only with a consent covering the
    `prescription` type. They never see notes.
  - Admins and support see neither.
- **Video:** short-lived, per-participant tokens with opaque identities; random room
  names; no media through the backend.
- **Prescribing rules:** narcotic and psychotropic substances are blocked in online
  consultations (a configurable list, not a compliance claim).
- **Notices:** generic wording only, with no medicines, notes or diagnoses.

## Follow-ups and the inbox (M10, ADR-0026)

- **Escalation:**
  - Escalation is **rule-based**: any warning sign means `urgent`, with fixed
    emergency guidance shown to the patient immediately and an urgent notice to the
    doctor. "Worse" means review.
  - AI never decides escalation, never contacts patients, and its summary is visible
    only to the doctor, labelled as AI.
- **Answers:**
  - The patient side can only answer an open check-in, enforced by RLS plus a trigger.
  - Answers are append-only, and notes are envelope-encrypted.
  - The audit log stores counts only.
- **Inbox:**
  - Notices (email and inbox) are generic: no symptoms, warning signs, notes or
    medicines.
  - Inbox rows are visible only to their owner, only their read time can change, and
    they cannot be deleted.

## Administration, observability and account recovery (M11, ADR-0027)

- **Admin UI:**
  - Account administration uses reason codes, never free text.
  - Doctor and clinic roles can be granted only through their workflows.
  - Every read and search is audited.
  - Support can look accounts up but cannot change them, read the audit log or run
    operations.
- **Deny by default:** a test walks every API route and requires 401 for anonymous
  callers, except the public allowlist in `routeSecurity.test.js`.
- **Bull Board:**
  - It is read-only and runs in the worker on a loopback-only port, never through Nginx.
  - Basic auth is compared in constant time, and credentials are never logged.
  - It is disabled without a 16-character or longer password.
  - Job data is identifiers only.
- **Metrics:** labels are low-cardinality enums. The AI metrics carry workflow, model,
  status, latency, tokens and spend, never content. Prometheus and Grafana bind to
  127.0.0.1, and Grafana requires an admin password (no anonymous access, no sign-up).
- **Browser error reports:** they contain the error class, kind and route template (IDs
  replaced). Messages and stacks are never sent because they can contain on-screen PHI.
- **Password reset:**
  - Tokens are single-use, 256-bit and stored hashed. They expire after 30 minutes and are
    replaced by newer links.
  - They are delivered in the link **fragment**, so they never reach servers or logs, and
    the page strips them from the address bar.
  - Requests are enumeration-safe in both content and timing.
  - A reset revokes all sessions, lifts the lockout and sends a notice.
  - **Residual:** email is the recovery factor until MFA (Phase 2).
- **Email verification:** the link is sent at registration and on request, expires after
  24 hours and is single-use.

## Deployment (M12, ADR-0028)

- **TLS:**
  - at the edge (TLS 1.2+, HSTS, redirect);
  - to managed PostgreSQL and Redis (`DB_SSL=verify-full`, `REDIS_TLS`);
  - STARTTLS required for SMTP in staging and production.
- **Containers:**
  - read-only root filesystems with tmpfs `/tmp` for the API, worker and AI service;
  - all Linux capabilities dropped on ECS;
  - memory limits and log rotation.
- **Secrets:**
  - single host: a root-only environment file generated with fresh random values;
  - AWS: Secrets Manager references only. The task-definition renderer refuses
    plain-text secrets.
  - CD uses AWS OIDC, so no long-lived cloud keys are stored, and the staging host key is
    pinned.
- **Backups:**
  - encrypted with age (the private key is offline) and checksummed;
  - documents copied through rclone crypt;
  - restores verified against a snapshot-consistent manifest, in CI on every build and in
    the DR rehearsal.
- **Exposure:** only 80/443 are public. Data services have no host ports, the MinIO
  console is off, and operator tools are loopback-only.
- **Residual:**
  - the single-host stack uses MinIO root credentials for the app;
  - the single-host RPO equals the backup interval (no WAL archiving);
  - the AWS path is defined and tested as manifests but has not been deployed from this
    repository.
