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
| M2 | Patients, doctors, clinics, relationships, AccessPolicy v2 | Next |
| M3–M12 | See [roadmap](docs/ARCHITECTURE_PROPOSAL.md#16-implementation-order) | Planned |

## Architecture at a glance

- **frontend/**: React + Vite + Tailwind CSS SPA, served by unprivileged Nginx
- **backend/**: Node.js/Express modular monolith (REST `/api/v1`), Knex migrations, BullMQ workers
- **ai-service/**: Python/FastAPI, internal only. Provider-neutral `LLMProvider` (Claude first), LangGraph agents (later milestones)
- **shared/**: constants and schemas shared by the frontend and backend
- **infra/**: Nginx and PostgreSQL bootstrap configuration
- **docs/**: architecture, ADRs and development guide

Core invariants: **AI proposes → backend validates → backend commits** · three-gate access
control (role, relationship, consent) with RLS as defence in depth · transactional
outbox · immutable signed clinical records · source-grounded AI with citations.

See [ARCHITECTURE](docs/ARCHITECTURE.md), [SECURITY](docs/SECURITY.md), [API](docs/API.md),
[DATABASE](docs/DATABASE.md) and [DECISIONS](docs/DECISIONS.md).

## Quick start

```bash
npm ci
node scripts/generate-env.mjs          # local .env with random secrets (never committed)
docker compose up -d --build --wait
```

Then open the web URL printed by `generate-env` (default `http://localhost:8080`).
Full instructions: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Repository layout

```
healthbridge/
├── frontend/      React SPA (Vite, Tailwind, React Router, TanStack Query)
├── backend/       Express API, migrations, scripts, tests
├── ai-service/    FastAPI AI service (uv, pytest, ruff)
├── shared/        @healthbridge/shared
├── infra/         nginx/, postgres/init/
├── docs/          ARCHITECTURE, DECISIONS (+ adr/), DEVELOPMENT, proposal
├── scripts/       generate-env.mjs
├── .github/       CI workflow, Dependabot
└── docker-compose.yml
```
