# ADR-0027: Administration UI, observability and account recovery

- **Status:** Accepted
- **Date:** 2026-10-03
- **Builds on:** ADR-0015 (authentication), ADR-0016 (audit), ADR-0020 (workers),
  ADR-0006 (access control)

## Context

M11 makes the platform operable and closes the remaining Phase 1 identity gaps:

- administrators need to manage accounts, read the audit trail and see background-job
  health;
- operators need queue visibility and metrics without seeing patient content;
- users need to recover a forgotten password and confirm their email.

None of these may weaken the patient-data boundary. Administration never implies access
to clinical records.

## Decision

### Administration UI

- **Users** (`users:read`, platform admin and support):
  - search and filter accounts, and view an account;
  - platform admins can also disable or reinstate an account with a reason code (never
    free text), grant or remove directly grantable roles, and sign the user out
    everywhere;
  - doctor and clinic roles are never offered: they come only from verification and
    clinic workflows;
  - every list and read is audited.
- **Audit log** (`audit:read`): filters for category, outcome, action, actor, patient,
  resource type, request ID and date range, with keyset pagination.
  - Filter values are validated, so they cannot be used for SQL tricks or arbitrary text
    searches.
  - Reading the trail is itself audited.
- **Operations** (`operations:manage`): outbox and dead-letter counts, per-queue job
  counts and dead letters with an audited retry. If Redis is down, the page says the
  outbox is holding events.

### Bull Board

- Bull Board runs **inside the worker**, on an internal port (`9466`).
- Compose publishes it on **127.0.0.1 only**. It is never routed through Nginx.
- It is **read-only**: retrying, cleaning or promoting jobs returns 405. Retries go
  through the audited admin API.
- Access requires HTTP Basic credentials from the environment, compared in constant
  time, and failed attempts are logged without the supplied credentials.
- Without `BULL_BOARD_PASSWORD` (16 or more characters) the board does not start.
- Job data contains only identifiers, statuses, dates and amounts. This was verified for
  every queue: there is no patient content to expose.

### Metrics and dashboards

- The API (`:9464`), worker (`:9465`) and AI service (`:8000/metrics`, new) expose
  Prometheus metrics on the private network only.
- AI metrics cover purpose, provider, model, status, latency, tokens and estimated
  spend. Like the logs, they contain metadata and never content.
- An optional Compose profile `observability` adds:
  - Prometheus (15-day retention) with alert rules: service down, API 5xx rate and p95
    latency, outbox relay failures, dead letters, rejected payment webhooks, browser
    error spikes and LLM errors;
  - Grafana with a provisioned overview dashboard.
- Both bind to 127.0.0.1. Grafana refuses to start without an admin password, and
  anonymous access and sign-up are disabled.
- Alert routing (Alertmanager to a pager) belongs to the production deployment (M12).

### Browser error reporting

- The SPA reports render errors, unhandled rejections and window errors to
  `POST /telemetry/client-errors`.
- The report contains **only**:
  - the error class (unknown names collapse to `Other`);
  - the kind;
  - the route template, with identifiers replaced by `:id`.
- Messages, stack traces and query strings are rejected, because they can contain
  patient data rendered on screen. The schema is strict.
- Reports are capped at 10 per page load, rate-limited per IP, counted in
  `client_errors_total` and logged without content.

### Password reset and email verification

- **Tokens:** `account_tokens` stores single-use tokens as SHA-256 hashes, with a
  database-enforced maximum lifetime of 48 hours.
  - A trigger only allows a token to be consumed once.
  - The app role cannot delete tokens.
  - A new link replaces older ones.
- **Delivery:** the token travels in the emailed link's **fragment**
  (`/reset-password#token=…`). Fragments are never sent to servers, proxies or access
  logs. The page reads the token and removes it from the address bar and history
  immediately.
- **Forgot password:** the API answers identically and immediately for every email. The
  work, including the email, happens after the response, so neither content nor timing
  reveals whether the account exists.
  - Limits: 10 requests per hour per IP and 3 per hour per account (hashed email key).
- **Reset:**
  - links expire after 30 minutes;
  - the password policy applies;
  - **all sessions are revoked** (`password_reset`) and any lockout is lifted;
  - the email address counts as verified;
  - a "your password was changed" notice is sent.
- **Email verification:**
  - links are sent on registration and on request;
  - they expire after 24 hours;
  - confirming is idempotent from the user's point of view: a second use gets the
    expired-link message.
- **Audit:** every outcome is audited (`auth.password_reset_request`,
  `auth.password_reset`, `account.email_verification_request`,
  `account.email_verified`), never with the token.
- **Links:** emailed links use `PUBLIC_APP_URL`, which must be `https://` in staging and
  production.
- **Sending:** these emails are sent directly by the API, like the registration notice,
  not through the outbox. This keeps secret tokens out of `outbox_events` and Redis. A
  lost email means requesting another link.

### Testing and review

- A route-inventory test walks every registered API route and asserts that anonymous
  callers get 401, except an explicit public allowlist (deny by default).
- A Playwright workspace (`e2e/`) runs browser journeys against the real stack with
  synthetic data:
  - patient: register, profile, care request, doctor accepts, book, pay through the signed
    webhook, inbox notification;
  - account recovery: email confirmation and password reset through Mailpit;
  - administration: users, audit log and operations, with clinical records denied;
  - edge security checks.
- CI runs the suite after the stack smoke test.
- The OWASP Top 10 review is recorded in [SECURITY_REVIEW.md](../SECURITY_REVIEW.md).

## Consequences

- Operators get queue, metric and audit visibility without any path to clinical
  content. Bull Board and Grafana are reachable only from the host (or, in production, a
  bastion or VPN).
- Password reset makes email the account-recovery factor. Until MFA (Phase 2) exists, a
  compromised mailbox can take over an account. The reset notice and full session
  revocation limit the damage but do not prevent it.
- Directly sent recovery emails are not retried by the outbox. This is acceptable
  because the user can request another link, and preferable to storing secrets in
  queues.

## Alternatives considered

- **Token in a query string:** rejected. It would reach Nginx access logs, Referer
  headers and browser history.
- **Bull Board behind the app's admin login:** rejected. Its UI calls its own API without
  our bearer token, and putting it behind Nginx would widen the public surface.
- **Sending the error message after "scrubbing" it:** rejected. Reliable PHI scrubbing of
  arbitrary text is not possible, so the safe design sends no text at all.
