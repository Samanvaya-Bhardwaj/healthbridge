# Architecture Decision Records

Each significant architectural decision is recorded as an ADR in [`docs/adr/`](adr/).
ADRs are immutable once accepted. A changed decision gets a new ADR that supersedes the
old one.

| ADR | Decision | Status |
|---|---|---|
| [0001](adr/0001-modular-monolith-and-independent-ai-service.md) | Modular monolith plus an independent, private AI service | Accepted |
| [0002](adr/0002-postgresql-pgvector-system-of-record.md) | PostgreSQL + pgvector as the single system of record | Accepted |
| [0003](adr/0003-knex-explicit-migrations-single-authority.md) | Knex, explicit SQL migrations, backend is the sole migration authority | Accepted |
| [0004](adr/0004-ai-proposes-backend-validates-commits.md) | AI proposes → backend validates → backend commits | Accepted |
| [0005](adr/0005-transactional-outbox-bullmq.md) | Transactional outbox → BullMQ, idempotent consumers | Accepted |
| [0006](adr/0006-layered-access-control-rls-least-privilege.md) | RBAC + relationship + consent; AccessPolicy; RLS and least-privilege DB roles; audit everything | Accepted |
| [0007](adr/0007-provider-abstractions.md) | Provider abstractions: LLM, video (LiveKit), payments (Razorpay), storage, notifications | Accepted |
| [0008](adr/0008-llm-usage-and-phi-policy.md) | LLM usage and PHI policy (Claude for dev on synthetic data; production gate) | Accepted |
| [0009](adr/0009-immutable-clinical-records-versioning.md) | Immutable signed clinical records with explicit versioning | Accepted |
| [0010](adr/0010-source-grounded-extraction-patient-scoped-rag.md) | Source-grounded extraction; patient-scoped RAG; insufficient-evidence fallback | Accepted |
| [0011](adr/0011-bounded-workflow-agents.md) | Bounded, workflow-defined agents (LangGraph) | Accepted |
| [0012](adr/0012-ai-execution-records.md) | AI execution records (`ai_runs`) without raw sensitive prompts | Accepted |
| [0013](adr/0013-object-storage-s3-minio.md) | S3-compatible object storage; MinIO (Chainguard image) locally | Accepted |
| [0014](adr/0014-monorepo-workspaces-and-dev-environment.md) | Monorepo with npm workspaces; repository outside cloud-sync folders | Accepted |
| [0015](adr/0015-authentication-tokens-and-sessions.md) | Ed25519 access tokens, per-request session validation, rotating refresh sessions with reuse detection, CSRF | Accepted |
| [0016](adr/0016-audit-log-model.md) | Single append-only `audit.audit_logs` table (refines proposal's two-table sketch) | Accepted |

Template: Context → Decision → Consequences (→ Alternatives considered).
