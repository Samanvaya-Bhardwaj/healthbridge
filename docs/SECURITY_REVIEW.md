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
4. The audit log is not stored externally. Since step 9 it is tamper-evident: a keyed
   hash chain over settled ranges (ADR-0035). The newest 10–15 minutes are not sealed yet.
5. There is no WAF or bot management in front of Nginx.
6. The fake scanner, payment, email and LLM providers are development defaults. Each is
   refused in production by configuration checks.

---

# Security review: M13.1 care assistant (independent, post-merge)

- **Milestone:** M13.1 · **Date:** 2026-10-14
- **Scope:** M13.1 as merged on `main` (`c571bd9..d423050`), including its pre-merge
  hardening. That covers:
  - the `agent_sessions` schema and RLS;
  - the backend turn loop, tools and routes;
  - the backend ↔ AI-service boundary (scope tokens, the `/v1/agent/step` contract,
    keyed input digests, `ai.ai_runs`);
  - the LangGraph step and prompt;
  - the Assistant page.
- **Method:** a manual code review against ADR-0029, ADR-0012 and ADR-0008. The two
  emergency-wording rules were also compared with a seeded differential fuzz of 30,000
  generated messages.

**Already sound on `main`:**

- **Sessions:** RLS ties sessions to their owner and the patient side, for every read,
  insert and update. A guardianship that ends hides its sessions at once.
- **Turns:** AccessPolicy re-checks scope on every turn.
- **Tools:** an explicit allow-list of read-only tools. Arguments are checked strictly,
  permissions are checked per tool, and the AI never supplies a patient identifier.
- **Untrusted AI output:** forged doctor or slot IDs and out-of-contract state are
  dropped, and cards are built only from backend data.
- **Digests:** free-text inputs are kept only as backend HMAC digests. There is one
  subkey per purpose, and the AI service never holds the key. Legacy plain hashes were
  cleared, and a constraint refuses new unkeyed ones.
- **Emergency wording:** the backend screens it before any AI call, even in an ended
  session or past the turn limit.
- **Frontend:** a late reply for an earlier session or patient is dropped.
- **Nothing stored or rendered unsafely:** no message text in the database, audit or
  logs, and no raw HTML rendering.

**Findings fixed in this review:**

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | Safety | The two emergency rules disagreed. Python's `re.I` treats İ and ı as i and JavaScript did not, so "I want to kıll myself" got no guidance from the backend. The ASCII-only `\b`/`\w` in JavaScript also differed from Python's Unicode ones. In the fuzz, 3,269 of 30,000 messages disagreed, and in 1,655 the backend missed a match. Neither copy matched dash look-alikes ("self–harm") or "seizures" or "convulsions". | Both copies fold dash look-alikes and match the plurals. The JavaScript pattern uses Python-equivalent word boundaries and case folding. The fuzz now finds 0 disagreements, and the shared fixture pins the new cases. |
| 2 | Low | The prompt removed only the exact `</message>`. Case and spacing variants, opening tags, or a tag spliced together by the removal passed through. Output is schema-constrained, so the impact was limited. | Every variant is removed, repeatedly until none is left. The prompt version is bumped. |
| 3 | Low (latent) | `useSafeMutation.reset()` during a call in flight left its double-submit guard set, so every later call was ignored. No current caller does this. | `reset()` clears the guard, and a new hook test covers it. |

**Carried forward:**

- **View-only guardians:** they may use the read-only assistant. When M13.4 adds booking,
  booking must keep requiring a `manage` guardianship, which the appointment service
  enforces.
- **Patient identifier in AI calls:** the AI service receives it in the patient-scope
  token (ADR-0022), to enforce the scope and label `ai.ai_runs`. It never reaches a
  prompt.
- **Wording coverage:** the emergency rule matches fixed English wording only. Forms it
  does not list, misspellings and other languages are not caught. Widening it is a
  safety-policy decision.

---

# Security review: step 9 (records, access and audit)

- **Date:** 2026-10-15
- **Scope:** medical documents, permission-based access to records, clinical notes and
  prescription history, and the audit trail.
- **Method:** a code review of the M5, M7 and M9 controls against their claims in
  SECURITY.md, plus a new suite-wide audit coverage check.

**Checked and holding** (evidence: `backend/tests/integration/`):

| Control | Evidence |
|---|---|
| Uploads are quarantined and scanned. Nothing becomes AVAILABLE without a verdict, a verified SHA-256 and a detected type. The browser is never trusted for type, extension, content, size or checksum. | `records.test.js`: upload and validation tests |
| Every document request needs a permission, a relationship and an active consent in scope. Strangers, clinic admins and platform admins are refused, and RLS refuses the same accesses when the application layer is bypassed. | `records.test.js`: document access and RLS |
| Revoking consent takes effect on the next request. URLs issued before the revocation live only until their TTL (at most 300 s). | `records.test.js`: revocation |
| Signed notes and prescriptions are immutable. Corrections are new signed versions, the patient sees only signed notes, and other doctors see prescriptions only with a consent that covers them. | `consultations.test.js`: SOAP notes and prescriptions |
| Prescription history (signed and superseded) is consent-gated for other doctors, and their reads are audited. A tampered prescription is never rendered. | `consultations.test.js` |
| Patients see who accessed what, in plain language. | `records.test.js`: patient access log |

**Changed in this step:**

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | Medium | Owner-level database access could rewrite or delete audit entries without trace (residual risk 4). | Keyed hash chain over settled ranges, an integrity check for admins, and a verify command ([ADR-0035](adr/0035-tamper-evident-audit-and-coverage.md)). Tests cover changed, deleted and back-dated entries, an altered seal, a missing key, concurrent sealers, and the append-only and contiguity rules. |
| 2 | Low | Audit coverage was by convention only. | The harness fails any test file in which a successful mutation left no audit row. The exceptions are listed with reasons and checked against the route table. |
| 3 | Low | Ending an assistant conversation was not audited, although starting one was (found by #2). | `assistant.session_ended` records the turn count only. |

**Carried forward:**

- The newest 10–15 minutes of the audit log are not sealed yet.
- Someone holding both owner access and the application key could rebuild the chain.
  The `audit range sealed` log lines are the cross-check. External, write-once storage of
  the seals is Phase 2.
- Own-record reads by patients and guardians are not audited, by design; reads by
  clinicians are.

---

# Security and safety review: step 10 (AI features)

- **Date:** 2026-10-15
- **Scope:**
  - the care assistant;
  - document intelligence;
  - the doctor brief and record questions (RAG);
  - follow-up summaries;
  - the AI service's limits.
- **Method:** a code review against ADR-0004, ADR-0008, ADR-0012, ADR-0022, ADR-0024 and
  ADR-0029, backed by the tests named below.

**Checked and holding:**

| Control | Evidence |
|---|---|
| **Grounded answers:** brief and record-question sentences must cite retrieved, authorised sources. Uncited or number-inconsistent sentences are dropped. No evidence gives the exact fallback "Insufficient information. Please consult the doctor." without a model call. | `ai-service/tests/test_assist.py`; `backend/tests/integration/assist.test.js` |
| **Grounded cards:** assistant cards are built from backend tool results only. IDs the backend did not return are dropped, and the model writes no free text that reaches the person. | `backend/tests/integration/assistant.test.js`; `ai-service/tests/test_care_assistant.py` |
| **Retrieval is scoped:** RAG reads only consented documents and verified facts for a treating doctor with the patient's AI opt-in. Hybrid retrieval is patient- and document-scoped at the database (RLS on the AI role). | `assist.test.js`; `ai-service/tests/test_db_rls.py` |
| **Emergency safeguards:** the backend screens every assistant message before any AI call. The shared rule is identical in both services (shared cases plus a differential fuzz), and the guidance works with the AI service down. Follow-up red flags escalate to urgent for the doctor. | `backend/tests/unit/assistantSafety.test.js`; `followups.test.js` |
| **AI suggestions stay separate from decisions:** extracted lab values join the record only when a consented treating doctor verifies them, with values copied server-side from the proposal. Briefs are labelled AI with feedback. The assistant has no write tool; booking, rescheduling and cancelling are confirmed on their pages. Outcomes and prescriptions are the doctor's alone. | `intelligence.test.js`; `consultations.test.js`; `assistant.test.js`; frontend `assistant.test.jsx` |
| **Limits:** per-user AI rate budgets (assistant 120/h, briefs and questions 60/h); 500-character messages; 3 tool rounds; 40 turns; 16 KB of state kept 24 h; model timeouts and `max_tokens`. | `assistant.test.js`; route configuration |
| **External processing:** refused in production unless `LLM_EXTERNAL_PROCESSING_APPROVED=true` (ADR-0008); the fake provider is refused in production. | `ai-service/tests/test_config.py` |

**Changed in this step** ([ADR-0036](adr/0036-ai-safeguards-budget-and-record-answers.md)):

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | Medium | No platform-wide bound on model spend once an external provider is enabled. | `LLM_DAILY_BUDGET_USD`, mandatory with an external provider and enforced across replicas before each call. Unpriced models refuse to start. Every feature falls back at the ceiling. There is a metric and an alert. |
| 2 | Medium (reliability) | A passing outage, timeout or rate limit during document extraction stored a `failed` extraction that was then reused, so the document was never analysed. | Retryable failures store nothing and answer 503. The job retries, and dead letters are retryable. |
| 3 | Low (completeness) | "My appointments" and "my medicines" only linked to pages. | The backend shows the session patient's upcoming appointments and recent signed medicines after the AI step, labelled "From your records". Nothing is sent to the AI or stored, and the audit records a count only. |

**Carried forward:**

- The ceiling uses list-price estimates (`PRICING_AS_OF`). Calls already in flight when
  it is reached still complete.
- Answering patients' free-text record questions in the assistant would send clinical
  text to a model. It stays a separate decision under ADR-0008.
- The emergency rule matches fixed English wording only (unchanged from M13.1).
