# HealthBridge API

Base path: **`/api/v1`**. JSON request and response bodies. Errors use RFC 9457
`application/problem+json`:

```json
{ "type": "https://healthbridge.dev/problems/invalid_credentials", "title": "Unauthenticated",
  "status": 401, "detail": "Invalid email or password.", "instance": "/api/v1/auth/login",
  "code": "invalid_credentials", "requestId": "4672f3c9a6ae9468af4a54a22010373e" }
```

Every response carries `X-Request-Id`; send your own (16–64 chars of `[A-Za-z0-9-]`) to
correlate requests. Lists use cursor pagination: `?limit=1..100&cursor=<opaque>`, with
the next cursor returned in `meta.nextCursor`.

## Authentication

| Mechanism | Used by |
|---|---|
| `Authorization: Bearer <access token>` | all protected endpoints |
| `hb_refresh` cookie + `X-CSRF-Token` header (= `hb_csrf` cookie) + allowed `Origin` | `/auth/refresh`, `/auth/logout` |

401 codes:
- `unauthenticated` (missing credentials);
- `token_expired` (refresh, then retry);
- `token_invalid`;
- `session_invalid` (sign in again);
- `invalid_credentials`;
- `refresh_conflict` (retry the refresh).

403 codes:
- `forbidden` (permission missing);
- `csrf_origin_rejected` and `csrf_token_invalid`;
- `account_unavailable`;
- `consent_required` (from M2).

429 `rate_limited` comes with `Retry-After`.

## Endpoints (M1)

| Method | Path | Auth | Permission | Notes |
|---|---|---|---|---|
| GET | `/meta` | — | — | API name/version, demo mode |
| POST | `/auth/register` | — | — | Always `202` with the same body (enumeration-safe). Creates a PATIENT. |
| POST | `/auth/login` | — | — | Returns an access token and sets the `hb_refresh` and `hb_csrf` cookies |
| POST | `/auth/refresh` | cookie + CSRF | — | Rotates the refresh token, returns a new access token |
| POST | `/auth/logout` | cookie + CSRF | — | `204`, idempotent, clears cookies |
| GET | `/auth/me` | Bearer | — | Current user, roles, permissions |
| GET | `/auth/sessions` | Bearer | `sessions:read` | Own active sessions |
| DELETE | `/auth/sessions/:id` | Bearer | `sessions:revoke` | Own sessions only (`404` otherwise) |
| POST | `/auth/sessions/revoke-others` | Bearer | `sessions:revoke` | Keeps the current session |
| GET | `/users/me` | Bearer | `account:read` | Account profile |
| PATCH | `/users/me` | Bearer | `account:update` | `{ fullName }` |
| POST | `/users/me/password` | Bearer | `account:update` | Revokes all other sessions |
| GET | `/admin/users` | Bearer | `users:read` | Filters: `role`, `status`, `q` (≥2 chars) |
| GET | `/admin/users/:id` | Bearer | `users:read` | |
| PATCH | `/admin/users/:id/status` | Bearer | `users:update` | `{ status, reasonCode }`; disabling revokes sessions |
| PUT | `/admin/users/:id/roles/:role` | Bearer | `admin:users` | Idempotent grant |
| DELETE | `/admin/users/:id/roles/:role` | Bearer | `admin:users` | Cannot remove own or last PLATFORM_ADMIN |
| POST | `/admin/users/:id/sessions/revoke` | Bearer | `admin:sessions` | |
| GET | `/admin/audit-logs` | Bearer | `audit:read` | Filters: `actorUserId`, `action`, `outcome`, `category`, `requestId`, `from`, `to`. The read itself is audited. |

Infrastructure endpoints (not routed through Nginx): `GET /health/live`,
`GET /health/ready`, and `GET :9464/metrics`.

## Examples

**Register**

```http
POST /api/v1/auth/register
{ "email": "asha@demo.healthbridge.local", "password": "river lantern quiet mango",
  "fullName": "Asha Rao", "acceptTerms": true }

202 Accepted
{ "data": { "status": "received", "message": "Thanks. If this email can be used for a new account, you can now sign in. If you already have an account, sign in or check your email." } }
```

**Login**

```http
POST /api/v1/auth/login
{ "email": "asha@demo.healthbridge.local", "password": "river lantern quiet mango" }

200 OK
Cache-Control: no-store
Set-Cookie: hb_refresh=<sessionId>.<secret>; Max-Age=1209599; Path=/api/v1/auth; HttpOnly; SameSite=Strict
Set-Cookie: hb_csrf=<token>; Max-Age=1209599; Path=/; SameSite=Strict
{ "data": { "accessToken": "eyJhbGciOiJFZERTQSIsImtpZCI6Ii4uLiIsInR5cCI6ImF0K2p3dCJ9…",
  "tokenType": "Bearer", "expiresIn": 600, "sessionExpiresAt": "2026-10-15T16:38:38.000Z",
  "user": { "id": "019a…", "email": "asha@demo.healthbridge.local", "fullName": "Asha Rao", "roles": ["PATIENT"] } } }
```

**Wrong password or unknown account** (identical)

```http
401 Unauthorized
WWW-Authenticate: Bearer error="invalid_credentials"
{ "status": 401, "code": "invalid_credentials", "detail": "Invalid email or password.", … }
```

**Refresh**

```http
POST /api/v1/auth/refresh
Origin: http://localhost:8081
Cookie: hb_refresh=…; hb_csrf=…
X-CSRF-Token: <hb_csrf value>

200 OK   (same body shape as login; new hb_refresh cookie)
```

**Permission denied** (also written to the audit log)

```http
GET /api/v1/admin/users
Authorization: Bearer <patient token>

403 Forbidden
{ "status": 403, "code": "forbidden", "detail": "You do not have permission to perform this action.", … }
```

## Endpoints (M2)

All patient-data endpoints go through AccessPolicy:
- **404** means not related, including guessed IDs;
- **403 `forbidden`** means the permission is missing;
- **403 `consent_required`** means there is no consent basis.

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/patients/me` | `patients:write` | Create own health profile (once) |
| GET / PATCH | `/patients/me` | `patients:read` / `patients:write` | Own profile; partial updates validated against the merged profile |
| GET / POST | `/patients/me/dependents` | `dependents:manage` | List / create dependents (creates a `manage` guardianship) |
| GET / PATCH | `/patients/:id` | `patients:read` / `patients:write` | Self, guardian or treating doctor (read). Response includes `access.relationship`. |
| GET | `/patients/:id/guardians` | `patients:read` | Active guardianships |
| POST | `/guardianships/:id/end` | `dependents:manage` | Guardian or patient; the last manager ending it archives a dependent without an account |
| GET | `/care-relationships?patientId=` | `care_relationships:read` | Care team (own profile by default) |
| POST | `/care-relationships` | `care_relationships:manage` | `{ patientId, doctorId, clinicId? }` → PENDING |
| POST | `/care-relationships/invitations` | `care_relationships:manage` | Verified doctors; `{ email }` → always `202` (enumeration-safe); rate-limited |
| POST | `/care-relationships/:id/{accept,decline,withdraw,pause,resume,end}` | `care_relationships:manage` | Party rules enforced (e.g. only the doctor accepts PENDING; only the patient pauses) |
| GET | `/doctors/me/patients?status=` | `care_relationships:read` | Doctor's relationships; patient details only via AccessPolicy |
| POST / GET / PATCH | `/doctors/me` | `doctor_profile:manage` | Own doctor profile; registration fields locked while pending, under review or verified |
| POST / GET | `/doctors/me/verification` | `doctor_profile:manage` | Submit / history (internal notes hidden) |
| GET | `/doctors/me/clinics` | `doctor_profile:manage` | Own clinic memberships |
| GET | `/doctors?q=&specialization=&clinicId=` | `doctors:read` | Directory: verified and active only |
| GET | `/doctors/:id` | `doctors:read` | Public profile (404 unless verified and active) |
| GET | `/admin/doctor-verifications?status=` | `admin:doctors` | Queue (pending and under review by default) |
| GET | `/admin/doctor-verifications/:id` | `admin:doctors` | Case and profile (read is audited) |
| POST | `/admin/doctor-verifications/:id/start-review` | `admin:doctors` | pending → under_review |
| POST | `/admin/doctor-verifications/:id/decision` | `admin:doctors` | `{ decision: verified|rejected, reasonCode, notes? }` |
| POST | `/admin/doctors/:id/suspend` | `admin:doctors` | `{ reasonCode, notes? }`; removes DOCTOR |
| POST / GET | `/admin/clinics` | `admin:clinics` | Create / list clinics |
| PATCH | `/admin/clinics/:id/status` | `admin:clinics` | `active` / `inactive` (inactive suspends clinic roles) |
| POST | `/admin/clinics/:id/admins` | `admin:clinics` | `{ userId }` → membership plus clinic-scoped CLINIC_ADMIN |
| GET | `/clinics/:id` | `clinics:read` (global or for this clinic) | Clinic info |
| GET | `/clinics/:id/members` | `clinic:manage` for this clinic, or `admin:clinics` | |
| POST | `/clinics/:id/doctors` | `clinic:manage` for this clinic, or `admin:clinics` | `{ doctorId }` (verified only) → INVITED |
| POST | `/clinics/:id/members/:membershipId/end` | Clinic manager, or the member leaving | The last clinic admin cannot leave |
| POST | `/clinic-memberships/:id/{accept,decline}` | `doctor_profile:manage` | The invited user only |

`/auth/me` now also returns `clinicRoles` and `clinicPermissions`.
`PUT /admin/users/:id/roles/{DOCTOR|CLINIC_ADMIN}` returns `400 role_requires_workflow`.

**Example: a treating doctor reads a patient**

```http
GET /api/v1/patients/0199…
Authorization: Bearer <doctor token>

200 OK
{ "data": { "id": "0199…", "fullName": "Asha Rao", "dateOfBirth": "1990-05-14", …,
  "access": { "relationship": "treating_doctor" } } }
```

**An unrelated doctor reads the same patient**: the response is identical for random IDs.

```http
404 Not Found
{ "status": 404, "code": "not_found", "detail": "The requested resource was not found.", … }
```

## Endpoints (M3)

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET / POST | `/doctors/me/availability` | `availability:manage` | Weekly rules; overlap → `409 availability_overlap`; in-clinic requires active membership |
| DELETE | `/doctors/me/availability/:ruleId` | `availability:manage` | Archives (existing bookings unaffected) |
| GET / POST | `/doctors/me/time-off` | `availability:manage` | Response reports `clashingAppointments` |
| DELETE | `/doctors/me/time-off/:id` | `availability:manage` | |
| GET | `/doctors/:doctorId/slots?from&to&mode&clinicId` | `doctors:read` | Verified doctors; ≤ 31 days; UTC |
| POST | `/appointments` | `appointments:create` | `{ patientId, doctorId, startsAt, mode, clinicId?, reason }`; optional `Idempotency-Key` header. Errors: `care_relationship_required`, `slot_not_offered`, `slot_unavailable`, `patient_double_booked`, `idempotency_conflict` |
| GET | `/appointments?patientId&scope=upcoming|past` | `appointments:read` | Patient side |
| GET | `/appointments/:id` | `appointments:read` | Reason included for the patient side and the doctor only |
| POST | `/appointments/:id/cancel` | `appointments:manage` | `{ reasonCode }` |
| POST | `/appointments/:id/reschedule` | `appointments:manage` | `{ startsAt }`; patient side; atomic |
| POST | `/appointments/:id/{check-in,complete,no-show}` | `appointments:manage` | Party and time rules (ADR-0019) |
| GET | `/doctors/me/appointments?from&to` | `appointments:read` | Doctor schedule (≤ 62 days) |
| GET | `/clinics/:clinicId/appointments?from&to` | `appointments:read` for that clinic | References, doctors and statuses; no patient identity |

**Example: booking**

```http
POST /api/v1/appointments
Idempotency-Key: 6f1c…
{ "patientId": "0199…", "doctorId": "0199…", "startsAt": "2026-10-05T09:15:00+05:30",
  "mode": "online", "reason": "Follow-up on blood sugar readings" }

201 Created
{ "data": { "id": "0199…", "reference": "4F2A9C1B", "status": "confirmed",
  "startsAt": "2026-10-05T03:45:00.000Z", "endsAt": "2026-10-05T04:00:00.000Z",
  "mode": "online", "feePaise": 0, "reason": "Follow-up on blood sugar readings", … } }
```

## Endpoints (M4)

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/appointments/:id/payment` | `payments:create` (patient side) | Body must be `{}`. Creates or reuses the order. Returns `{ payment, holdExpiresAt, checkout: { provider, orderId, amountPaise, currency, keyId? } }`. Errors: `payment_not_required`, `appointment_not_payable`, `payment_hold_expired`, `payment_not_open`, `503 payment_provider_unavailable` |
| GET | `/appointments/:id/payment` | `payments:read` (patient side) | Receipt: status, amount, refunded amount, refunds |
| POST | `/appointments/:id/refunds` | `payments:refund` (doctor party, or that clinic's admin) | `{ reasonCode: goodwill \| duplicate_payment \| other, amountPaise? }`. **`Idempotency-Key` required**. `202` new, `200` replay. `409 refund_exceeds_payment` |
| POST | `/appointments/:id/payment/simulate` | `payments:create` | **Fake provider, non-production only.** `{ outcome: success \| failure }`. Submits a signed test webhook through the normal path |
| POST | `/webhooks/payments/:provider` | none (HMAC signature) | Raw body; `x-razorpay-signature` / `x-razorpay-event-id` (or the fake's `x-fake-*`). `200 { received, duplicate, status }`, or `400 invalid_webhook` |
| GET | `/admin/operations/summary` | `operations:manage` | Outbox and dead-letter counts, queue counts |
| GET | `/admin/operations/dead-letters?status&limit` | `operations:manage` | Identifiers and failure reasons only |
| POST | `/admin/operations/dead-letters/:id/retry` | `operations:manage` | Re-queues the job (or re-opens the outbox event); audited |

Appointment views now include `paymentStatus`, the status only, for every party who can
see the appointment. `GET /admin/audit-logs?category=financial` filters financial audit
rows.

## Endpoints (M5)

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/consents` | `consents:manage` (patient or managing guardian) | `{ patientId, doctorId, kind: manual \| appointment, appointmentId?, scopes[], documentTypes?, purpose, expiresInDays? }`. Errors: `care_relationship_required`, `appointment_not_eligible`, `409 consent_exists` |
| GET | `/consents?patientId` | `consents:read` (patient side) | Effective status (`expired` once elapsed) |
| GET | `/consents/received` | `consents:read` | Doctor: consents held |
| POST | `/consents/:id/revoke` | `consents:manage` | `{ reasonCode? }`. Takes effect on the next request. `409 consent_not_active` |
| POST | `/patients/:patientId/documents/upload-intent` | `medical_records:write` (+ upload consent for doctors) | `{ documentType, title, filename, contentType, sizeBytes, sha256 }`. Returns `{ document, upload: { method: POST, url, fields, expiresAt } }`. `413 file_too_large` |
| POST | `/documents/:id/complete` | `medical_records:write` (uploader) | Idempotent. `409 upload_not_found` |
| GET | `/patients/:patientId/documents?includeRetired` | `medical_records:read` + consent | Metadata only |
| GET | `/documents/:id` | `medical_records:read` + consent | Metadata only |
| GET | `/documents/:id/download` | `medical_records:read` + consent | `{ url, expiresAt, filename }`: presigned GET (TTL 60 s by default). `409 document_not_available` |
| POST | `/documents/:id/retire` | `medical_records:write` (patient side) | Record kept; hidden |
| GET | `/patients/:patientId/access-log?cursor&limit` | `access_log:read` (patient side) | Plain-language entries; `meta.nextCursor` |

Responses never contain storage keys, credentials, permanent URLs or document contents.

## Endpoints (M6)

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET / PUT | `/patients/:patientId/ai-processing` | `patients:read` / `patients:write` (patient side) | `{ enabled }`. Enabling queues existing documents |
| GET | `/documents/:id/extraction` | `medical_records:read` + consent | Latest AI proposal: `{ status, needsReview, injectionWarning, classification, documentDate, issuer, labResults[{ key, analyte, value, unit, referenceRange, flag, quote, verified }] }` |
| POST | `/documents/:id/lab-results/verify` | `lab_results:verify` (treating doctor + `medical_documents` consent) | `{ fieldKeys[] }` only. Errors: `unknown_field`, `no_extraction` |
| GET | `/patients/:patientId/lab-results` | `medical_records:read` + consent | Verified values with source quote and verifier |

Internal (AI service): `POST /v1/documents/analyze` (service token + `X-Patient-Scope`).
