# Validation report (step 11)

- **Date:** 2026-10-15
- **Commit:** the step 11 merge on `main` (see `git log`)
- **Environment:** one development machine (Docker Desktop on Windows), with the full
  Compose stack and synthetic data only. Nothing here was measured on AWS or with real
  providers.

This report gathers the evidence that the whole system works as specified before
deployment readiness (step 12). It is an engineering record, **not** a certification,
penetration test or compliance statement (ADR-0008).

## 1. Quality gates

`npm run check` runs 13 gates against the running stack. CI runs the same checks on every
push, plus gitleaks over the full history.

| Gate | Result | Size |
|---|---|---|
| Lint (ESLint), formatting (Prettier) | PASS | whole repository |
| Backend unit tests | PASS | 22 files, 261 tests |
| Frontend tests (Vitest, Testing Library) | PASS | 23 files, 97 tests |
| Frontend production build | PASS | |
| Dependency audit (production) | PASS | 0 high or critical |
| Backend integration tests (PostgreSQL, Redis, MinIO) | PASS | 29 files, 277 tests |
| AI service lint and tests (with the database) | PASS | 202 tests |
| Browser end-to-end journeys (Playwright) | PASS | 8 specs: 16 passed, 1 skipped (live video needs `--video`) |
| Backup image; backup and restore drill (throw-away key, scratch database) | PASS | manifest identical |
| Secret scan (gitleaks) on every merged range | no leaks | |

The integration suite also enforces **audit coverage** (ADR-0035): every successful
state-changing request in every test file must leave an audit row with its request ID,
apart from the reasoned exceptions in `backend/tests/integration/auditCoverage.js`.

## 2. Security reviews

| Review | Scope | Where |
|---|---|---|
| OWASP Top 10 (2021) pass (M11) | web, edge, API, workers, AI service, data services, CI | [SECURITY_REVIEW.md](SECURITY_REVIEW.md) |
| Care assistant, independent post-merge (M13.1) | sessions, tools, prompts, emergency rule parity, state | same file |
| Step 9: records, access and audit | documents, consent, immutable notes and prescriptions, audit | same file |
| Step 10: AI features | grounding, retrieval, limits, emergency safeguards, AI vs decisions | same file |

Every finding from these reviews was fixed or recorded as a residual risk with its reason.
The residual risks that still stand are listed in §10.

## 3. Realistic data

All data is synthetic and created through the real services, with the same validation,
authorisation, RLS, audit and immutability rules as the app (`npm run seed:demo`).

- **Accounts:** the main demo accounts (two patients, a dependent, three doctors, a clinic
  admin, a platform admin, support).
- **Directory:** 10 cities, 20 clinics (one closed), about 120 doctors and 40 patients with
  dependents, care teams and upcoming visits (`syntheticDirectory.js`, fixed seed).
- **Clinical history** (`seedHistory.js`, new in this step):
  - three past visits for Asha with signed SOAP notes and prescriptions, one of them
    corrected;
  - answered and closed check-ins, and one still to come;
  - a past visit for her dependent that asked for an in-clinic visit, now booked and paid;
  - synthetic lab reports, scanned and, with the patient's opt-in, read by the AI for the
    doctor to verify.

  These were created on a shifted service clock, so they really happened "in the past"
  for every rule that reads time.
- **Held-out evaluation data** is separate (seeds 7 and 99; §6).

A fresh database seeds completely inside the migrate container, which is the CI path, in
about 24 s. A second run changes nothing.

## 4. Concurrency

| Race | Guarantee | Test |
|---|---|---|
| Many patients book the same slot | exactly one wins (exclusion constraint) | `scheduling.test.js` |
| Bookings while a clinic closes or a doctor leaves | never an open booking at a closed site (FOR SHARE guard) | `eligibility.test.js` |
| Payment webhook against the hold sweeper | one valid final state | `payments.test.js` |
| Refresh-token replay within and after the grace window | benign race kept; real reuse revokes the session | `auth.test.js` |
| Parallel audit sealers | one contiguous chain | `auditSeals.test.js` |
| **New:** one prescription signed several times at once | signed once, audited once | `concurrency.test.js` |
| **New:** a paid appointment cancelled several times at once | cancelled once, one event, so one refund | `concurrency.test.js` |
| **New:** one check-in answered several times at once | one answer kept; the rest refused | `concurrency.test.js` |
| Duplicate jobs (outbox re-publish, retries, stalls) | idempotent handlers, deterministic job IDs | `workers.test.js`, `records.test.js` |

## 5. Accessibility

- **Automated:** axe-core (WCAG 2.0 and 2.1, A and AA) runs on 26 pages in the browser
  suite (`e2e/tests/accessibility.spec.js`), with the demo data loaded:
  - public: sign in, register, password reset;
  - patient: home, My Doctors, appointments, booking, records, prescriptions, timeline,
    follow-ups, privacy, assistant, notifications, account settings;
  - doctor: today, patients, schedule, follow-ups, professional profile;
  - administration: overview, users, verification, clinics, audit log, operations.

  **Result: 0 violations of any impact on every page** (19 to 28 rules applicable per
  page). Serious and critical violations fail the run.
- **Earlier manual work:** the UX quality review ([UX_QUALITY_REVIEW.md](UX_QUALITY_REVIEW.md))
  fixed:
  - colour contrast of state colours;
  - keyboard reach of scrollable tables and the week grid;
  - focus and the tab title on route changes;
  - accessible names.

  It also re-checked dialog focus traps, skip links and announced errors.
- **Not done:** a screen-reader pass (NVDA or VoiceOver) by a person, and testing with
  disabled users. Automated rules find only a part of real accessibility problems.

## 6. Held-out evaluations

| Evaluation | Data | Result |
|---|---|---|
| Doctor search (ADR-0031) | 120 held-out queries (seed 99) on an unseen directory (seed 7) | constraint precision 1.00, eligibility violations 0, recall@10 1.00, no-match accuracy 1.00, area MRR 1.00, name MRR 1.00 (half with typos) ([DOCTOR_SEARCH.md](evaluations/DOCTOR_SEARCH.md)) |
| Conversational clarification (ADR-0033) | 24 conversations, 40 turns | clarification precision 1.00, unnecessary questions 0.00, criteria 1.00, stale criteria 0.00, routing 1.00, safety violations 0 ([CLARIFICATION.md](evaluations/CLARIFICATION.md)) |
| Care assistant intent (fake model) | synthetic set | intent, specialty, day and window at least 90% (gated); emergency recall 100% with no model call |

These measure the logic around the model on synthetic data. They do not measure a real
model's language understanding; that needs its own held-out human wording before external
processing is enabled.

## 7. Monitoring

- **Metrics:**
  - API and worker: HTTP latency and status by route template, outbox, queues and dead
    letters, payments, access denials, the care assistant, audit seals;
  - AI service: LLM calls, latency, tokens, estimated spend, budget refusals.

  Labels never carry identifiers or patient data.
- **Alerts:** 11 rules (`infra/observability/alerts.yml`, checked with promtool):
  - availability: services down, 5xx rate, latency;
  - background: outbox, dead letters, webhook rejections;
  - clients and AI: browser errors, LLM errors, daily budget;
  - audit: seal verification failure, sealing stalled.
- **Dashboard:** `healthbridge-overview` (Grafana) gains AI spend today, budget refusals,
  seals written and seal failures.
- **Logs:** structured, content-free (no message text, prompts, tokens or keys). Each
  audit seal's chain value is logged as a copy outside the database.

## 8. Recovery

- **Backup and restore drill:** a gate on every check, and in CI. It backs up with a
  throw-away key, restores into a scratch database and compares a manifest of migrations,
  row counts, RLS tables, triggers and the audit guard.
- **Full disaster-recovery rehearsal** (OPERATIONS.md §8): data volumes deleted and
  restored from the encrypted backup alone; documents byte-identical; 71 s for the demo
  dataset.
- **Audit integrity after a restore:** `npm run audit:verify -w backend` checks the whole
  seal chain (OPERATIONS.md §12).
- **Deferred AI work after an outage:** document analysis is retried with backoff, and
  dead letters are retryable from Admin → Operations (ADR-0036).

## 9. Defects found while validating

| Found by | Defect | Fix |
|---|---|---|
| Seeding the history | The scheduling services ignored the injected clock that every other service uses. | Wired in; the clock-driven suites pass. |
| Browser journeys after a database restart | The AI service's pool handed out a dead connection. The spend ceiling's read failed with a plain error, so the assistant fell back. | Pooled connections are checked before use. A failed read keeps the last total for up to 10 minutes, otherwise refuses as "unavailable" (test_budget.py). |
| Browser journeys after the accessibility scans | 26 page scans from one IP used up the per-IP API limit (300 a minute), so the next journey was throttled. | The scans run last, as their own project, and reset the local counters first (never against shared environments). |
| The records journey | Integration tests move clocks forward and run the global follow-up sweep, which opened the demo check-in early. | The journey checks the check-in, not its state. |

## 10. Not validated, or accepted as residual

| Item | Status |
|---|---|
| Capacity and load at production volumes | Not measured. Concurrency correctness is tested, throughput is not. Do it on staging with the production rate limits. |
| Real providers (Razorpay, SMTP relay, LiveKit, ClamAV, Claude, Voyage) | Rehearsed earlier for SMTP, ClamAV and TLS (OPERATIONS.md §8). Payments, video and the LLM run on fakes in CI. External AI processing is **not approved** (ADR-0008). |
| AWS deployment | Manifests rendered and tested; never deployed from this repository. |
| Penetration test, external privacy and compliance review | Not done; required before real patient data (ADR-0008). |
| MFA for staff, externally stored audit seals, WAF | Phase 2 (SECURITY.md). |
| Manual screen-reader pass | Not done (§5). |
