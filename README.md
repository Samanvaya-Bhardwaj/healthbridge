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

## Architecture at a glance

- **frontend/**: React + Vite + Tailwind CSS SPA, served by unprivileged Nginx
- **backend/**: Node.js/Express modular monolith (REST `/api/v1`), Knex migrations, BullMQ workers
- **ai-service/**: Python/FastAPI, internal only. Provider-neutral `LLMProvider` (Claude first; offline fake by default), bounded LangGraph agents (documents, brief/RAG, follow-ups)
- **shared/**: constants and schemas shared by the frontend and backend
- **infra/**: Nginx (plain/TLS), PostgreSQL bootstrap, observability (Prometheus, Grafana), deployment (production Compose, ECS, backups)
- **e2e/**: Playwright browser journeys
- **docs/**: architecture, ADRs, security review, operations runbook and development guide

Core invariants: **AI proposes → backend validates → backend commits** · three-gate access
control (role, relationship, consent) with RLS as defence in depth · transactional
outbox · immutable signed clinical records · source-grounded AI with citations.

See [ARCHITECTURE](docs/ARCHITECTURE.md), [SECURITY](docs/SECURITY.md), [API](docs/API.md),
[DATABASE](docs/DATABASE.md) and [DECISIONS](docs/DECISIONS.md).

## Quick start

You need Docker Desktop and Node.js 24.

```bash
git clone https://github.com/Samanvaya-Bhardwaj/healthbridge.git && cd healthbridge
npm start          # secrets, build, every service, demo data; prints URLs and sign-ins
```

- **Options:** `npm start -- --video` (live video), `--scanner` (ClamAV),
  `--observability` (Grafana).
- **Everyday commands:** `npm stop`, `npm run logs`, `npm run reset`.
- **Verify everything:** `npm ci && npm run check`.

**The complete guide** covers running, the demo tour, testing, deployment, troubleshooting,
and what's included or not: **[RUNNING.md](RUNNING.md)**.

## Deployment

- **Single host (staging or small production):** `infra/deploy/compose.prod.yml` with TLS,
  ClamAV and encrypted backups.
- **AWS (production):** ECS Fargate task definitions in `infra/deploy/ecs/`.
- **Releases:** a `v*` tag runs the CD pipeline: build and scan the images, push them
  with an SBOM and provenance, deploy to staging with a smoke test and automatic rollback,
  then deploy to production after approval.
- **Details:** see the [operations runbook](docs/OPERATIONS.md) and
  [ADR-0028](docs/adr/0028-deployment-tls-backups-cd.md).

## Repository layout

```
healthbridge/
├── frontend/      React SPA (Vite, Tailwind, React Router, TanStack Query)
├── backend/       Express API, migrations, scripts, tests
├── ai-service/    FastAPI AI service (uv, pytest, ruff)
├── shared/        @healthbridge/shared
├── e2e/           Playwright browser journeys (patient, recovery, admin, security, video)
├── infra/         nginx/, postgres/init/, observability/, deploy/ (prod Compose, ECS, backup)
├── docs/          ARCHITECTURE, SECURITY(+_REVIEW), API, DATABASE, OPERATIONS, DECISIONS (+ adr/)
├── scripts/       start.mjs (npm start), check.mjs (npm run check), generate-env, backup-drill
├── .github/       CI and CD workflows, Dependabot
├── RUNNING.md     the complete run/use/verify/deploy guide
└── docker-compose.yml
```
