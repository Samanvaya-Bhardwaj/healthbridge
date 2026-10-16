# HealthBridge: run, use, verify and deploy

This is the one guide you need: what HealthBridge is, how to start it with one command,
what to try, how to check that everything works, how to deploy it, and what is and isn't
included yet.

> **Synthetic data only.** Never enter real patient information. HealthBridge makes no
> regulatory or compliance claims. Real patient data requires the review described in
> [ADR-0008](docs/adr/0008-llm-usage-and-phi-policy.md).

---

## 1. What you need

| Requirement | Notes |
|---|---|
| **Docker Desktop** (or Docker Engine with Compose v2) | Give it at least **6–8 GB RAM** (about 3 GB more with `--scanner`). On Windows use the WSL2 backend. |
| **Node.js 24** | Only used to run the start script; no `npm install` is needed to run the app. |
| **Git** | On Windows, clone **outside** OneDrive or Dropbox (e.g. `C:\dev\healthbridge`). |

## 2. Run everything with one command

```bash
git clone -b main https://github.com/Samanvaya-Bhardwaj/healthbridge.git && cd healthbridge
npm start
```

That's all. `npm start`:

1. creates `.env` with fresh random local secrets, and picks free ports if 8080, 5432 and
   so on are taken;
2. builds and starts **every** service and waits until each one is healthy;
3. loads the synthetic demo data (safe to repeat);
4. prints the URLs and demo sign-ins.

The first run builds the images and takes a few minutes. Later starts take seconds.

**Optional flags:** combine as needed, e.g. `npm start -- --video --observability`.

| Flag | Adds |
|---|---|
| `--video` | **Real video consultations**: a local LiveKit server, with camera and microphone in the browser |
| `--scanner` | The real ClamAV virus scanner instead of the development stand-in (needs about 3 GB RAM; the first start downloads signatures) |
| `--observability` | Prometheus (metrics and alert rules) and Grafana (dashboard) |
| `--no-build` | Skips rebuilding images (fastest restart) |
| `--no-seed` | Skips (re)loading the demo data |

**Everyday commands:**

| Command | Does |
|---|---|
| `npm start` | Start, or update and restart, everything |
| `npm stop` | Stop everything (data is kept) |
| `npm run logs` | Follow the logs of all services |
| `npm run reset` | **Delete all local data** (database, files, queues). The next `npm start` begins fresh |

## 3. What is running

The printed summary shows the exact ports. These are the defaults:

| Service | Address | Purpose |
|---|---|---|
| **HealthBridge** (web app + API) | http://localhost:8080 | The application |
| Mailpit | http://localhost:8025 | Every email the app sends (booking notices, password reset, …) |
| Bull Board | http://localhost:3010 | Read-only background-job queues (user `ops`, password `BULL_BOARD_PASSWORD` in `.env`) |
| Grafana / Prometheus | http://localhost:3001 / :9090 | Only with `--observability` (Grafana: `admin` / `GRAFANA_ADMIN_PASSWORD`) |
| LiveKit | ws://localhost:7880 | Only with `--video` |

**Internal services** have no public address:

- PostgreSQL with pgvector;
- Redis;
- MinIO (document storage);
- the AI service (FastAPI + LangGraph, with an offline fake LLM by default);
- the background worker;
- ClamAV (with `--scanner`).

All host ports listen on `127.0.0.1` only.

## 4. Try it: demo accounts

Every demo account uses the password shown by `npm start` (`DEMO_USER_PASSWORD` in
`.env`).

| Sign in as | Email | Try this |
|---|---|---|
| Patient | `patient.asha@demo.healthbridge.local` | **Doctors** → book with Dr. Meera (online visits are free; in-clinic visits cost ₹500, paid with the test provider). **Health Records** → upload a PDF. **Privacy & Access** → see who viewed your records, grant or revoke consent. **Timeline**, **Follow-ups**, notification bell. |
| Patient | `patient.vikram@demo.healthbridge.local` | A second patient, who cannot see Asha's data |
| Doctor | `dr.meera@demo.healthbridge.local` | **Patients** → accept care requests. **Medical Records** → consented records and AI-assisted brief with citations. A consultation → SOAP note, prescription (signed PDF), outcome, follow-up. |
| Doctor | `dr.rahul@demo.healthbridge.local` | A second verified doctor |
| Doctor applicant | `dr.applicant@demo.healthbridge.local` | Unverified; waits in the verification queue |
| Clinic admin | `clinic.admin@demo.healthbridge.local` | Clinic members and schedule |
| Platform admin | `platform.admin@demo.healthbridge.local` | **Doctor Verification**, **Clinics**, **Users**, **Audit Log**, **Operations**. No access to medical records, by design. |
| Support | `support@demo.healthbridge.local` | Account lookup only |

**A larger synthetic directory** (M13.2) is seeded too, with the same password: 10 cities, 20 clinics (one closed, to show that its times disappear), about 120 doctors and 40 patients with dependents, care teams and upcoming visits. Doctor accounts look like `dr.imran.joshi.001@demo.healthbridge.local`, and patient accounts like `patient.aditi.31@demo.healthbridge.local`. All of it is synthetic, generated from a fixed seed (`backend/scripts/lib/syntheticDirectory.js`). Try the **Assistant** with, for example, "a dermatologist in Pune who speaks Marathi, online".

**Clinical history** (step 11) is seeded for the main demo patients through the real services, as if it happened over the last ten weeks:

- **Asha** has three past online visits with Dr. Meera about blood sugar. Each has a signed SOAP note and a signed prescription, and one prescription has a correction with its reason. Two check-ins are answered and closed, and one is still to come.
- **Kamala** (Asha's dependent) had a blood-pressure review that asked for an in-clinic visit. That visit is booked and paid with the test provider.
- **Lab reports:** synthetic PDFs (blood count, HbA1c, lipids) are scanned. With Asha's opt-in, the AI reads hers, so Dr. Meera has lab values to verify.
- **A synthetic health file** (Part 4) of 25 more documents, each a realistic PDF from a named (fictional) lab, hospital or clinic, with consistent dates and values. All three patients have AI reading turned on, so their documents are read and indexed.
  - **Asha** (type 2 diabetes, on metformin): annual health check, HbA1c and sugars, vitamin D and iron, ECG, dietitian notes, urine microalbumin, retinal screening, a 2024 gastroenteritis discharge and a thyroid profile.
  - **Kamala** (Asha's mother: blood pressure, cholesterol, knees): cataract surgery discharge, lipids, a Deccan Heart Clinic prescription (telmisartan, atorvastatin), knee X-ray and orthopaedic letter, kidney function, ECG, echocardiogram and a home BP log. Kamala has also given Dr. Meera consent to her documents.
  - **Vikram** (asthma): asthma-attack discharge, chest X-ray, spirometry, allergy tests, a pulmonology letter, lipids and sugar, and vaccinations.

Try **Health Records → Ask about your documents** as Asha ("How has my HbA1c changed?", "What did the eye check show?"), or ask the **Assistant** the same. Switch to Kamala in the assistant and ask "What did my echo show?". As Dr. Meera, ask about Asha's or Kamala's records on **Patient Records → Ask AI**.

Try **Prescriptions**, **Timeline** and **Follow-ups** as Asha, or ask the **Assistant** "What medicines do I need to take?". As Dr. Meera, open **Patient Records** → Asha.

**Live video:**

1. Start with `npm start -- --video`.
2. Book an **online** appointment for the next few minutes.
3. Open the appointment as the doctor and as the patient (use two browsers or a private
   window).
4. The doctor clicks **Start consultation**, then both click **Join video**.

**Testing the API directly:** open [`api-tests.http`](api-tests.http) in VS Code with the
*REST Client* extension. It covers every endpoint, signs in as each demo role and chains
tokens and IDs. It reads the port and demo password from your `.env`.

**Password reset:** **Sign in** → **Forgot your password?** The email arrives in Mailpit.

**Local AI with Ollama** (prompts and records stay on this machine):

1. Install [Ollama](https://ollama.com) and pull a chat model and an embedding model:
   `ollama pull llama3.2` and `ollama pull nomic-embed-text`.
2. In `.env`, set:

   ```
   LLM_PROVIDER=ollama
   LLM_MODEL_DEFAULT=llama3.2:latest
   LLM_MODEL_FAST=llama3.2:latest
   LLM_TIMEOUT_SECONDS=600
   EMBEDDING_PROVIDER=ollama
   OLLAMA_EMBED_MODEL=nomic-embed-text
   AI_SERVICE_TIMEOUT_SCALE=15
   ```

3. Run `npm start -- --no-build`. The AI service reaches Ollama at
   `host.docker.internal:11434`.
4. Existing documents get vectors of the new embedding model when the worker starts, in
   the background (about a minute for the demo documents). To do it now:
   `docker compose exec api node scripts/reembed-records.js`. It prints the counts.

On a laptop CPU a 3B model answers in about 10–40 seconds, and the first message after a
start is the slowest (the model loads). Tapping a doctor, a day or a time needs no model at
all. Larger models (`llama3.1`) understand better but take a minute or more per message
without a GPU. `npm run check` and CI keep using the offline fake model, so their results
don't depend on a model.

**Using Claude instead of the offline fake model:**

1. In `.env`, set `LLM_PROVIDER=claude`, `ANTHROPIC_API_KEY=…` and a daily spend ceiling, `LLM_DAILY_BUDGET_USD=5` (required with an external model; see ADR-0036).
2. Run `npm start -- --no-build`.

Still synthetic data only.

## 5. Check that everything works

```bash
npm ci            # once: installs the test tooling
npm run check     # every quality gate against the running stack
```

`npm run check` runs these gates and prints a pass/fail table:

- lint and formatting;
- backend unit tests and **integration tests** (real PostgreSQL, Redis and MinIO; the
  worker is paused and restarted automatically);
- frontend tests and the production build;
- AI-service lint and tests (with the database);
- the dependency audit;
- **browser end-to-end journeys** (Playwright, which installs Chromium itself);
- an **encrypted backup and restore drill**.

**Variants:**

- `npm run check -- --quick`: static checks and unit tests only, no stack needed.
- Live video test: start with `--video`, then run:

  ```bash
  E2E_VIDEO=1 npm run test:e2e -w e2e -- --project=video
  ```

  It waits for a real consultation window, about 5 minutes.

CI (`.github/workflows/ci.yml`) runs the same checks, plus secret scanning, image
scanning, the full-stack smoke test and the backup drill.

## 6. Deploying

See the [operations runbook](docs/OPERATIONS.md) and
[ADR-0028](docs/adr/0028-deployment-tls-backups-cd.md).

**Before any deployment**, read [docs/DEPLOYMENT_READINESS.md](docs/DEPLOYMENT_READINESS.md):
it lists the owner decisions that block production (external AI processing, live
payments, video) and the checklist for every release.

**Single host (staging or a small clinic):** a few commands on the server, after creating
the environment file:

```bash
node infra/deploy/make-env.mjs --env staging --domain your.domain \
  --age-recipient age1… --version v1.0.0 > /etc/healthbridge/healthbridge.env
# Fill in SMTP (and, for production, the live providers), then check it (names only):
node infra/deploy/preflight.mjs --env-file /etc/healthbridge/healthbridge.env \
  --backend-image <registry>/healthbridge-backend:v1.0.0 --ai-image <registry>/healthbridge-ai:v1.0.0
docker compose -f infra/deploy/compose.prod.yml \
  --env-file /etc/healthbridge/healthbridge.env up -d --wait
node infra/deploy/smoke.mjs https://your.domain
```

You get:

- TLS with HSTS, ClamAV, read-only containers;
- encrypted hourly backups, restore drills and disaster recovery;
- Let's Encrypt via `--profile acme`.

**AWS:** ECS Fargate task definitions are in `infra/deploy/ecs/`. They use RDS (pgvector),
ElastiCache, S3, Secrets Manager and an ALB.

**Releases:** pushing a `v*` tag runs `.github/workflows/cd.yml`:

1. build and scan the images, then push them with an SBOM and provenance;
2. deploy to staging, run the smoke test, and roll back automatically on failure;
3. deploy to production on ECS after approval.

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| "Docker is installed but not running" | Start Docker Desktop and run `npm start` again |
| "HealthBridge data already exists…" or "password authentication failed" | All copies of the project share one set of Docker data. A new `.env` has new passwords that the old data rejects. Either `npm run reset` then `npm start` (fresh synthetic data), or copy the original `.env` into this folder |
| A port is already in use | Nothing to do: `.env` moves to the next free port, and the summary prints the URL in use |
| A service is not healthy | Run `npm run logs`. Then `npm start` again (it is safe to repeat), or `npm run reset && npm start` for a clean slate |
| "Too many attempts" during repeated manual testing | This is the rate limiting working. Wait, or `npm run reset` |
| Integration tests refuse to run | A worker is running. `npm run check` handles this; if you run the tests by hand, use `docker compose stop worker` first |
| Video shows "Camera or microphone is unavailable" | Allow camera and microphone for `localhost` in the browser. Make sure you started with `--video` |
| Upgraded and something is missing in `.env` | `npm start` adds new variables automatically and never rotates existing secrets |

Development with hot reload (running the apps on the host) is described in
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## 8. What's included, and what isn't (inspection, 2026-10-03)

**Complete (milestones M0–M12):**

- **Accounts:** registration, sign-in, rotating sessions, CSRF protection, lockout and
  rate limits, password reset and email verification, administrator account management.
- **Care network:** patient profiles and dependents (guardians); doctor profiles with
  admin credential verification; clinics; care relationships.
- **Scheduling and payments:** availability, slots and booking with holds, rescheduling,
  cancellation; payments with signed webhooks (test provider, plus Razorpay), refunds and
  a ledger.
- **Consent and records:**
  - consent that is scoped, expiring and revocable, checked on every request;
  - medical documents through quarantine → virus scan → promotion, with short-lived signed
    downloads;
  - a "who accessed my records" log.
- **AI** (opt-in per patient; it proposes, the backend validates, and humans decide):
  - document intelligence with OCR, grounded extraction and doctor-verified lab values;
  - a medical timeline with provenance;
  - a pre-consultation brief and record questions with citations and the exact fallback
    "Insufficient information. Please consult the doctor.";
  - an AI summary of follow-up check-ins for the doctor.
- **Consultations:**
  - waiting room and **live video** (LiveKit; a mock provider by default);
  - encrypted SOAP notes;
  - outcome A/B/C (decided only by the doctor);
  - signed, immutable prescriptions with PDFs and corrections.
- **Follow-ups and notifications:**
  - follow-ups with reminders and **rule-based** escalation, plus fixed 112/108
    emergency guidance;
  - email and in-app notifications.
- **Operations and security:**
  - admin console (users, audit log, operations), Bull Board, metrics, alerts and a
    dashboard;
  - content-free browser error reporting;
  - three-gate access control backed by PostgreSQL row-level security;
  - an append-only audit trail;
  - an OWASP Top 10 review ([docs/SECURITY_REVIEW.md](docs/SECURITY_REVIEW.md)).
- **Delivery:** CI, CD, production Compose, ECS manifests, TLS, backups, restore drill,
  and a rehearsed disaster recovery.

**Verified on 2026-10-03:**

- **One command:** `npm start` from a wiped machine state (no `.env`, no volumes) ran
  every service with demo data in about 45 s (base images cached).
- **`npm run check`:** all 13 gates passed:
  - 183 backend unit, 220 integration, 63 frontend and 79 AI-service tests;
  - 8 browser journeys;
  - the backup/restore drill.
- **Live video:** passed with real LiveKit and two browsers (Chromium synthetic media).
- **Staging rehearsal:** TLS, smoke test, e2e and disaster recovery
  ([OPERATIONS.md](docs/OPERATIONS.md) §8).

**Known limitations and planned work** (from the approved plan):

- **MFA (TOTP)** for clinicians and administrators is not implemented (Phase 2). Email is
  the account-recovery factor.
- **SMS/WhatsApp** has no real provider; messages are recorded by a stand-in. There are no
  notification preferences yet.
- **Clinic admin suite** (staff rota, billing overview), real-time waiting-room updates,
  analytics dashboards and second-opinion sharing are Phase 2.
- **Payments:** no automatic reconciliation job and no partial refunds; rescheduling a
  paid visit refunds it in full.
- **AWS:** the production path is defined and tested as manifests, but has not been
  deployed from this repository.
- **Single host:** the RPO equals the backup interval (default one hour).
- **Video:** consultations are not recorded (by design). Browser-to-LiveKit media in
  production needs TURN/TLS on the LiveKit side.
