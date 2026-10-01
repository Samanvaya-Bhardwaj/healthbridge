# ADR-0015: Authentication — access tokens, rotating refresh sessions, CSRF

- **Status:** Accepted (implemented in M1)
- **Date:** 2026-10-01
- **Refines:** proposal §11.1 (Tokens, CSRF)

## Context

A healthcare SPA needs short-lived credentials and immediate revocation: logout, account
disable and role changes must apply at once. XSS must not be able to steal long-lived
credentials, and refresh-token theft must be detectable.

## Decision

**Access token.** A JWT signed with **Ed25519** (`alg: EdDSA`, `typ: at+jwt`, `kid`).
- Lifetime: 10 minutes.
- Claims are identifiers only: `sub` (user), `sid` (session), `jti`, `iss`, `aud`, `iat`,
  `exp`. There are no roles or PII in the token.
- Held **in memory** by the SPA and sent as `Authorization: Bearer`. It is never stored
  in localStorage or sessionStorage.
- Verification pins the algorithm, `typ`, issuer, audience and required claims. Rotation
  is supported: previous public keys can be configured for verification.

**Per-request server-side validation.** After the signature check, every request loads
the session, the account status, the roles and the permission union in one query. A
revoked or expired session, or a disabled account, fails the very next request. Role
changes apply immediately. The JWT acts as a tamper-proof session pointer. This costs one
indexed query per request; a Redis cache with explicit invalidation can be added if load
requires it.

**Refresh session.** One `sessions` row per login.
- The refresh token is `<sessionId>.<256-bit secret>`, delivered in an `httpOnly; SameSite=Strict`
  cookie scoped to `Path=/api/v1/auth`, with `Secure` enforced outside development.
- Only SHA-256 hashes of the secret are stored. A slow hash is unnecessary for 256-bit
  random secrets.
- **Rotation on every refresh.** The previous hash is kept to detect replay:
  - presenting the previous token within **10 s** of rotation is a benign multi-tab race
    and returns `401 refresh_conflict` without revocation;
  - any other replay is treated as theft: the session is revoked
    (`refresh_token_reuse`) and a high-signal audit event is written.
- The SPA serialises refreshes across tabs with the Web Locks API, and uses a single
  in-flight refresh per tab.
- **Lifetimes by role.** Patients: 3 days idle, 14 days absolute. Doctors, clinic admins,
  platform admins and support: 12 hours idle, 3 days absolute. All four are configurable.

**CSRF** (only cookie-authenticated endpoints are affected: refresh and logout).
1. `SameSite=Strict` cookies.
2. `Origin`, falling back to `Referer`, must be an allowed application origin.
3. Double-submit check: the `X-CSRF-Token` header must equal the readable `hb_csrf` cookie.
4. Synchronizer check: the token's hash is stored with the session and verified server-side.

**Passwords.**
- Hashed with Argon2id (OWASP minimum: m=19 MiB, t=2, p=1) after NFKC normalisation, with
  transparent rehash on login if parameters increase.
- Policy follows NIST SP 800-63B: 12–128 characters, no composition rules, a deny-list of
  common passwords, and no email local part or name inside the password.

**Account enumeration resistance.**
- Registration returns the same `202` response for new and existing emails. The owner of
  an existing account is emailed instead.
- Login returns the same `401 invalid_credentials` for an unknown account, a wrong
  password, or a locked account. Timing is equalised with a dummy hash verification.
- A disabled account is reported only after the correct password is given.

**Failed logins and rate limits.**
- A temporary lock is applied after 5 consecutive failures (15 minutes).
- Redis rate limits apply per IP (login, registration, refresh), per account (login,
  keyed by a hashed email), per user (password change), plus a global per-IP API limit.

**Registration creates PATIENT accounts only.** Staff roles are granted by platform
administrators, and the first administrator is created with the `create-user` script.

## Consequences

- Logout, revocation, disabling and role changes are immediate. The cost is a database
  round trip per authenticated request.
- Stolen access tokens are useful for at most 10 minutes, and only while the session is
  alive. Refresh-token theft is detected on first replay.
- A temporary lockout can be abused to block a known account for 15 minutes. Rate limits,
  the short lock, and alerting on lock events (later milestone) mitigate this.
- **Not yet implemented** (planned): MFA (TOTP) for clinicians and admins, email
  verification, password reset, breached-password (k-anonymity) checks.
