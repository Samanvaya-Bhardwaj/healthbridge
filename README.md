# HealthBridge

**Consult your trusted local doctor first. Visit only when necessary.**

HealthBridge is a healthcare platform built around *continuity of care*. It keeps
patients connected to the local doctors they already trust, through online
consultations, connected medical records, consent-controlled sharing and follow-ups.
AI assists doctors and patients with document understanding, record retrieval and
consultation preparation. **Clinical decisions always stay with qualified professionals.**

> ⚠️ Development uses **synthetic data only**. This project makes no regulatory or
> compliance claims. Production use with real patient data requires the review described
> in [ADR-0008](docs/adr/0008-llm-usage-and-phi-policy.md).

## Status

| Milestone | Scope | Status |
|---|---|---|
| **M0** | Foundations: monorepo, Docker stack, DB roles and migrations, health checks, CI, ADRs | ✅ Complete |
| **M1** | Identity, sessions, RBAC, audit logging, auth UI | ✅ Complete |
| **M2** | Patients, dependents, doctors and verification, clinics, care relationships, RLS | ✅ Complete |
| **M3** | Availability, slots, booking, appointment lifecycle, clinic schedule | ✅ Complete |
| **M4** | Payments (fake + Razorpay), webhooks, ledger, outbox relay, workers, notifications, reminders | ✅ Complete |
| **M5** | Consent, medical documents (quarantine → scan → promotion), signed downloads, access log | ✅ Complete |
| **M6** | Document intelligence: opt-in AI extraction (text/OCR, grounded), chunk index, doctor-verified lab values | ✅ Complete |
| **M7** | Medical timeline with provenance, consent-scoped visibility, JSON export | ✅ Complete |
| **M8** | Doctor brief and patient-scoped RAG with citation validation and fallback | ✅ Complete |
| **M9** | Consultation and prescribing: waiting room, video adapter, SOAP notes, outcome A/B/C, signed immutable prescriptions + PDF | ✅ Complete |
| **M10** | Follow-ups and notifications: check-ins, reminders, rule-based escalation, AI summary for doctors, in-app inbox | ✅ Complete |
| **M11** | Admin UI (users, audit log, operations), Bull Board, metrics and dashboards, password reset and email verification, Playwright e2e, OWASP review | ✅ Complete |
| **M12** | Deployment: production Compose + ECS manifests, TLS, encrypted backups with restore drill and DR rehearsal, staging rehearsal, CD pipeline | ✅ Complete |
| **M13.1** | Agentic care assistant foundation: backend-owned turn loop over a bounded LangGraph planner, read-only tools, structured 24 h state, Assistant page | ✅ Complete |
| **M13.2** | Doctor search: one eligibility rule for search, slots and booking, shared specialty and area vocabulary, pgvector ranking over public profiles, held-out evaluation | ✅ Complete |
| **M13.3** | Recommendations with factual explanations; conversational clarification, corrections and refinements | ✅ Complete |
| **M13.4** | Booking in the conversation: recommend, pick a time, explicit Confirm, pay, calendar invite and notifications. The model has no write tool | ✅ Complete |
| **Hardening** | Tamper-evident audit chain, daily AI spend ceiling, validation report (gates, concurrency, accessibility, evaluations), deployment preflight | ✅ Complete |
| **Local AI** | Self-hosted models through Ollama (Llama 3.2, `nomic-embed-text`); patients ask about their own records (cited RAG); general health information from a reviewed library | ✅ Complete |

**Not hosted yet.** Everything runs locally with `npm start`. Production waits on the owner
decisions in [DEPLOYMENT_READINESS.md](docs/DEPLOYMENT_READINESS.md).

## Architecture at a glance

- **frontend/**: React + Vite + Tailwind CSS SPA, served by unprivileged Nginx
- **backend/**: Node.js/Express modular monolith (REST `/api/v1`), Knex migrations, BullMQ workers
- **ai-service/**: Python/FastAPI, internal only. Provider-neutral `LLMProvider` (Claude, self-hosted Ollama, or an offline fake by default) and embeddings (offline hashing, Ollama, Voyage); bounded LangGraph agents (care assistant, documents, brief/RAG, follow-ups, health information)
- **shared/**: constants and schemas shared by the frontend and backend
- **infra/**: Nginx (plain/TLS), PostgreSQL bootstrap, observability (Prometheus, Grafana), deployment (production Compose, ECS, backups)
- **e2e/**: Playwright browser journeys
- **docs/**: architecture, ADRs, security review, operations runbook and development guide

Core invariants: **AI proposes → backend validates → backend commits** · three-gate access
control (role, relationship, consent) with RLS as defence in depth · transactional
outbox · immutable signed clinical records · source-grounded AI with citations.

See [ARCHITECTURE](docs/ARCHITECTURE.md), [SECURITY](docs/SECURITY.md), [API](docs/API.md),
[DATABASE](docs/DATABASE.md) and [DECISIONS](docs/DECISIONS.md).

## Designed for older patients

The patient side works by picture, not by reading
([ADR-0042](docs/adr/0042-patient-home-in-pictures-and-a-tour.md)):

- **Six picture tiles** on the home page, and a photo with one plain sentence on each page.
- **A "Larger text" switch** in the header.
- **A guided tour** that lights up each part of the page in large type, offered and never
  forced.

Photos are hosted in the app; sources and licences are in
[IMAGE_CREDITS.md](docs/IMAGE_CREDITS.md).

## How the AI works

The model understands and summarises. Code decides, and the backend commits.

- **Care assistant** ([ADR-0029](docs/adr/0029-agentic-ai-orchestration.md),
  [ADR-0038](docs/adr/0038-booking-in-the-conversation.md)): a LangGraph graph (safety →
  understand → validate → route) in `ai-service/app/agents/care_assistant.py`.
  - The model fills one fixed JSON form (intent and preferences). Code checks every field
    against the person's own words ([ADR-0041](docs/adr/0041-the-form-is-checked-against-the-words.md)),
    picks one of five read-only tools and writes the tool arguments.
  - It recommends doctors, offers free times and proposes a booking. Only the person's
    **Confirm** books, through the app's own booking path; payment, a calendar invite and
    notifications follow in the chat.
- **Retrieval over records** ([ADR-0024](docs/adr/0024-doctor-brief-patient-scoped-rag.md),
  [ADR-0039](docs/adr/0039-patients-ask-about-their-own-records.md)):
  - PDF text or Tesseract OCR, then chunks and embeddings in pgvector, ranked together with
    full-text search under row-level security, within one patient's documents that the
    asker may see.
  - Sources reach the model newest first, by the date on the document, so "latest" means
    latest.
  - Answers keep only sentences that cite their sources and match their numbers; otherwise
    the exact "insufficient information" reply.
  - Every vector records its model. A model switch adds new vectors beside the old ones
    (append-only), and retrieval compares only vectors of one model.
- **Safeguards** ([ADR-0036](docs/adr/0036-ai-safeguards-budget-and-record-answers.md)):
  a deterministic emergency screen runs before any model call; a daily spend ceiling holds
  across replicas; every run records model, tokens and estimated cost, never the patient's
  text.
- **Health information** ([ADR-0040](docs/adr/0040-general-health-information.md)): code
  picks an article from a versioned library, and the model only writes a cited summary,
  validated sentence by sentence. Production serves only clinician-approved articles.
- **Evaluations** ([VALIDATION.md §6](docs/VALIDATION.md)): held-out doctor-search queries
  and hand-labelled assistant conversations. They test the logic around the model on
  synthetic data, not a model's language understanding.

## Quick start

You need Docker Desktop and Node.js 24.

```bash
git clone -b main https://github.com/Samanvaya-Bhardwaj/healthbridge.git && cd healthbridge
npm start          # secrets, build, every service, demo data; prints URLs and sign-ins
```

- **Options:** `npm start -- --video` (live video), `--scanner` (ClamAV),
  `--observability` (Grafana).
- **Everyday commands:** `npm stop`, `npm run logs`, `npm run reset`.
- **Verify everything:** `npm ci && npm run check`. The latest evidence (gates, reviews,
  concurrency, accessibility, evaluations, monitoring, recovery) is in
  [docs/VALIDATION.md](docs/VALIDATION.md).

**Taking over the project?** Start with the handover guide:
**[docs/PROJECT_WORKFLOW.md](docs/PROJECT_WORKFLOW.md)**. It covers the end-to-end workflow
phase by phase, the tech stack and where each part is used, the repository map, the rules
that must not be broken, and how to make common changes.

**Platform overview** (features, roles, flows, where AI is used):
**[docs/PLATFORM_OVERVIEW.md](docs/PLATFORM_OVERVIEW.md)**.

**The complete guide** covers running, the demo tour, testing, deployment, troubleshooting,
and what's included or not: **[RUNNING.md](RUNNING.md)**.

## Deployment

- **Single host (staging or small production):** `infra/deploy/compose.prod.yml` with TLS,
  ClamAV and encrypted backups.
- **AWS (production):** ECS Fargate task definitions in `infra/deploy/ecs/`.
- **Releases:** a `v*` tag runs the CD pipeline: build and scan the images, push them
  with an SBOM and provenance, deploy to staging with a smoke test and automatic rollback,
  then deploy to production after approval.
- **Before deploying:** [docs/DEPLOYMENT_READINESS.md](docs/DEPLOYMENT_READINESS.md) lists
  the owner decisions that block production and the release checklist, including the
  environment preflight (`infra/deploy/preflight.mjs`).
- **Details:** see the [operations runbook](docs/OPERATIONS.md) and
  [ADR-0028](docs/adr/0028-deployment-tls-backups-cd.md).

## Repository layout

```
healthbridge/
├── frontend/      React SPA (Vite, Tailwind, React Router, TanStack Query)
├── backend/       Express API, migrations, scripts, tests
├── ai-service/    FastAPI AI service (uv, pytest, ruff)
├── shared/        @healthbridge/shared
├── e2e/           Playwright journeys (patient, records, assistant, recovery, admin, security, accessibility, video)
├── infra/         nginx/, postgres/init/, observability/, deploy/ (prod Compose, ECS, backup)
├── docs/          ARCHITECTURE, SECURITY(+_REVIEW), VALIDATION, API, DATABASE, OPERATIONS, DECISIONS (+ adr/)
├── scripts/       start.mjs (npm start), check.mjs (npm run check), generate-env, backup-drill
├── .github/       CI and CD workflows, Dependabot
├── RUNNING.md     the complete run/use/verify/deploy guide
└── docker-compose.yml
```
