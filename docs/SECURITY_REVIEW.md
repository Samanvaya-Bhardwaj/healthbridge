# Security review: OWASP Top 10 (2021) pass

- **Milestone:** M11 · **Date:** 2026-10-03 · **Scope:** web SPA, Nginx edge, API, workers,
  AI service, PostgreSQL/Redis/MinIO configuration, CI.
- **Method:** code and configuration review against the OWASP Top 10 (2021) and selected
  ASVS 4.0 requirements, backed by automated tests and scanners (listed per item).

This is an internal engineering review. It is **not** a penetration test, a certification
or a compliance statement (see ADR-0008). Real patient data still requires the external
privacy, security and compliance review described there.

## Findings fixed during this review

| # | Finding | Fix |
|---|---|---|
| 1 | No password reset or email verification. Users locked out of their accounts had no recovery path. These were Phase 1 items in the plan. | Single-use, hashed, short-lived tokens delivered in a link fragment. Enumeration-safe requests, full session revocation on reset, audited. ([ADR-0027](adr/0027-admin-observability-account-recovery.md)) |
| 2 | Route authentication coverage was not tested exhaustively. | `routeSecurity.test.js` walks every registered route (more than 100). Anonymous requests must get 401 unless the route is on an explicit allowlist. |
| 3 | Browser errors were only logged to the console. Sending messages or stacks would leak on-screen PHI. | Content-free error reporting: error class, kind and route template only. Strict schema, capped and rate-limited. |
| 4 | Queue operations had no operator view. Exposing one carelessly risks the public surface. | Read-only Bull Board on a loopback-only port with constant-time Basic auth. Retries go through the audited API. |
| 5 | The patient UI still described payments as "arriving in an upcoming release" and clinical features as "upcoming". | Copy corrected. The home page now carries emergency-number guidance. |
| 6 | The first draft of the recovery endpoints put forgot, reset and verify in one per-IP bucket. This is too tight behind clinic NAT and easy to exhaust. | Separate buckets: forgot 10/h per IP and 3/h per account; token submissions 30 per 15 minutes per IP. Tokens are 256-bit, so this limit protects resources, not secrecy. |

## OWASP Top 10 (2021)

### A01 Broken access control: **controls in place**

- Three gates on every patient-data request ([ADR-0006](adr/0006-layered-access-control-rls-least-privilege.md), [ADR-0017](adr/0017-patient-scoped-authorization-rls.md)):
  1. permission (403);
  2. relationship (404, so existence is not revealed);
  3. active scoped consent (403 `consent_required`).

  PostgreSQL RLS repeats them, keyed to the acting user (`withActor`) or to a named system
  purpose.
- Administrators and support hold **no** clinical permissions. This is verified in the UI
  (navigation and route guards) and in the API (`adminObservability.test.js`,
  `authz.test.js`, `rls.test.js`).
- Deny by default: `routeSecurity.test.js` covers every API route. Webhooks are
  authenticated by HMAC signature instead (`payments.test.js`).
- The RBAC catalog is checked against the database at startup and in tests
  (`catalog.test.js`).

### A02 Cryptographic failures: **controls in place**

- Passwords: Argon2id (19 MiB, t=2).
- Tokens: Ed25519 JWTs with a 10-minute access-token lifetime. Refresh tokens, CSRF
  tokens and account tokens are stored as SHA-256 hashes only.
- High-sensitivity free text (SOAP notes, follow-up notes) is envelope-encrypted with
  AES-256-GCM, with key IDs and AAD binding to the record.
- Prescriptions are sealed with SHA-256 plus HKDF-derived HMAC.
- **TLS** (added in M12, ADR-0028):
  - **Edge:** TLS 1.2/1.3 with HSTS, and HTTP redirects to HTTPS. Termination happens in
    the web container (single host) or at the ALB (AWS).
  - **Managed services:** `DB_SSL=verify-full`, `REDIS_TLS` and SMTP STARTTLS (required
    in staging and production).
- **Residual:** key management uses environment variables, not a KMS (planned for
  production; ADR-0025).

### A03 Injection: **controls in place**

- All SQL goes through Knex bindings. The review found no user input interpolated into
  raw SQL; the only template literal in raw SQL is a constant (`NIL_UUID`).
- Every request body, query and params object is validated by strict Zod schemas, which
  reject unknown keys. Audit filters are pattern-restricted.
- React escapes output, and there is no `dangerouslySetInnerHTML`, `eval` or
  `new Function` anywhere.
- The CSP blocks inline script (`script-src 'self'` plus Razorpay only).
- LLM prompt injection: the AI service has no tools that write. Outputs are validated
  (citations, numbers, lexical support, unsafe-language filter) and never committed
  without backend validation (ADR-0004, ADR-0024).

### A04 Insecure design: **controls in place**

- Threat model in ARCHITECTURE_PROPOSAL §11.
- Clinical invariants are enforced in code and the database:
  - immutability triggers;
  - AI proposes, the backend validates and commits;
  - escalation decided by deterministic rules;
  - only the doctor chooses the outcome.
- The browser never decides that a payment succeeded: only the signed webhook does.
- Enumeration resistance on registration, login and password reset.

### A05 Security misconfiguration: **controls in place**

- Production configuration is refused at startup when unsafe:
  - demo mode, the fake payment provider, the fake scanner or fake email;
  - insecure cookies;
  - a missing clinical data key;
  - a non-HTTPS app URL (`config.test.js`).
- Nginx:
  - `server_tokens off`;
  - strict CSP and `frame-ancestors 'none'`;
  - `nosniff`, `Referrer-Policy: no-referrer` and a Permissions-Policy;
  - body limits and per-IP request limits.
- The API adds Helmet with `default-src 'none'` and sends `no-store` on token and admin
  responses.
- Internal surfaces are not public: metrics, health internals, Bull Board, Prometheus and
  Grafana. Checked by `e2e/tests/security.spec.js`.
- Containers run as unprivileged users. Images are scanned by Trivy (fixable
  high/critical findings fail CI).
- **Camera and microphone:** `Permissions-Policy` allows them only when live video is
  configured (`HB_MEDIA=on`, ADR-0028), and only for the app's own origin (`(self)`).
  Otherwise they stay `()`.

### A06 Vulnerable and outdated components: **controls in place**

- `npm audit` (0 vulnerabilities at review time), `uv`-locked Python dependencies, and
  Trivy on all three images.
- GitHub Actions are pinned by SHA, and the workflow is linted with actionlint.

### A07 Identification and authentication failures: **mostly in place**

- Password policy: 12–128 characters, a deny-list, and no name or email in the password.
- Lockout after 5 failures for 15 minutes (lifted by a password reset).
- Redis rate limits per IP, per account and per user.
- Server-side sessions with idle and absolute timeouts, rotation with reuse detection,
  and revocation on password change, password reset, account disable and admin action.
- CSRF protection on cookie endpoints.
- **Residual:**
  - No MFA yet (Phase 2 in the approved plan). This matters most for clinicians and
    administrators.
  - No breached-password (k-anonymity) check.

### A08 Software and data integrity failures: **controls in place**

- Webhook HMAC with a replay window and idempotency.
- The outbox pattern, idempotent consumers and dead letters with audited retry.
- Prescription integrity seals.
- The append-only audit log is enforced by privileges and triggers.
- Lockfiles committed; CI builds from the lockfiles.
- **Residual:** the audit log is not hash-chained or exported to WORM storage (Phase 2).

### A09 Security logging and monitoring failures: **controls in place**

- Audited:
  - authentication events;
  - authorisation denials;
  - administrative actions and reads;
  - patient-data decisions;
  - account recovery.

  Audit entries are append-only and viewable through the admin audit viewer.
- Logs never contain:
  - passwords, tokens or cookies;
  - recovery tokens;
  - medical content or AI prompts and outputs.

  Tests assert this for passwords, tokens and recovery tokens.
- Prometheus alert rules and a Grafana dashboard (ADR-0027) cover:
  - service health;
  - error and latency SLOs;
  - outbox failures and dead letters;
  - rejected webhooks;
  - browser errors;
  - LLM errors.
- **Residual:** Alertmanager routing to a pager still has to be configured for each deployment. The rules exist, but no pager integration is set up here.

### A10 Server-side request forgery: **controls in place**

- The backend makes no outbound requests to user-supplied URLs. Outbound targets are
  fixed by configuration: AI service, payment provider, SMTP, MinIO and LiveKit.
- Document access uses presigned URLs that are generated server-side after
  authorisation.
- The AI service is not reachable from the host or the public edge, and its endpoints
  require an internal JWT (verified in the CI smoke test).

## Automated evidence (run for this milestone)

| Check | Tooling |
|---|---|
| Route deny-by-default | `backend/tests/integration/routeSecurity.test.js` |
| Account recovery (single use, expiry, replacement, no enumeration, session revocation, consume-only tokens) | `backend/tests/integration/accountRecovery.test.js` |
| Admin boundaries, audit filters, Bull Board read-only/auth, content-free error reports | `backend/tests/integration/adminObservability.test.js` |
| Browser journeys and edge checks | `e2e/tests/*.spec.js` (Playwright) |
| Dependencies and images | `npm audit`, Trivy (backend, web, AI), gitleaks (staged and history in CI) |

## Residual risks (accepted for the synthetic-data phase)

1. No MFA, and email is the recovery factor (Phase 2: TOTP for clinicians and admins).
2. A presigned download URL issued before consent revocation stays valid until it
   expires (at most 300 s). This is documented in SECURITY.md.
3. Keys live in environment variables, not a KMS or HSM.
4. The audit log is not hash-chained or stored externally.
5. There is no WAF or bot management in front of Nginx.
6. The fake scanner, payment, email and LLM providers are development defaults. Each is
   refused in production by configuration checks.
