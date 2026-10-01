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
