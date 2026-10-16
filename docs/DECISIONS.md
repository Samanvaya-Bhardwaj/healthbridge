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
| [0017](adr/0017-patient-scoped-authorization-rls.md) | Relationship types, clinic-scoped roles, interim consent basis, RLS on patient-scoped tables | Accepted |
| [0018](adr/0018-doctor-verification-workflow-granted-roles.md) | Doctor verification state machine; DOCTOR/CLINIC_ADMIN granted only by workflows | Accepted |
| [0019](adr/0019-scheduling-on-demand-slots.md) | On-demand slots (refines materialised slots), care-team booking, DB-enforced no double booking, appointment lifecycle | Accepted |
| [0020](adr/0020-payments-webhook-authority-outbox-workers.md) | PaymentProvider/NotificationProvider, webhook-only payment authority, append-only ledger, outbox relay, BullMQ workers, DB-driven reminders, purpose-scoped system RLS | Accepted |
| [0021](adr/0021-consent-medical-documents-secure-access.md) | Explicit scoped/expiring consent checked per request; medical documents behind quarantine → scan → promotion; DocumentStorage with presigned POST/GET; patient access log on the audit trail | Accepted |
| [0022](adr/0022-document-intelligence.md) | Opt-in AI document analysis via scoped hand-off; LangGraph document agent without tools; grounded proposals and chunks in RLS-scoped `ai` tables; backend-validated metadata; doctor-verified lab values | Accepted |
| [0023](adr/0023-medical-timeline-projection.md) | Medical timeline as an idempotent, rebuildable projection with provenance on every event; consent-scoped RLS; JSON export | Accepted |
| [0024](adr/0024-doctor-brief-patient-scoped-rag.md) | Doctor brief and record questions: consent + opt-in + scope token; hybrid RLS-scoped retrieval; citation/number/support/safety validation; exact insufficient-information fallback | Accepted |
| [0025](adr/0025-consultations-prescribing.md) | Consultations: waiting room, video adapter, encrypted SOAP notes, outcome A/B/C by the doctor only, signed immutable prescriptions with integrity seal and PDF | Accepted |
| [0026](adr/0026-followups-notifications.md) | Follow-ups: due sweep, durable reminders, deterministic escalation (warning signs → urgent + fixed guidance), bounded AI summary for the doctor, in-app inbox | Accepted |
| [0028](adr/0028-deployment-tls-backups-cd.md) | Deployment: same signed images everywhere; single-host Compose with TLS and ECS Fargate task definitions; managed-service TLS; snapshot-consistent encrypted backups with manifest-verified restore drills; CD with staging smoke + rollback and approval-gated production | Accepted |
| [0027](adr/0027-admin-observability-account-recovery.md) | Admin UI (users, audit viewer, operations); read-only loopback Bull Board; Prometheus/Grafana profile and AI metrics; content-free browser error reports; password reset and email verification with fragment-delivered single-use tokens | Accepted |
| [0029](adr/0029-agentic-ai-orchestration.md) | Agentic care assistant: backend-owned turn loop over a bounded LangGraph planner; allow-listed backend tools on existing services; structured 24 h state, never transcripts; approval before any write (M13.4) | Accepted |
| [0030](adr/0030-one-eligibility-rule.md) | One eligibility rule (doctor account, profile, verification; open practice site) in PostgreSQL for the directory, slots and booking; a booking guard under row locks; ineligible future bookings withdrawn by the system with a full refund | Accepted |
| [0031](adr/0031-doctor-search.md) | Doctor search: shared specialty terms and areas of practice (database copies checked against them); one SQL search with hard filters (eligibility, specialty, city, language, mode, name), a deterministic ranking and reasons; no-match told apart from search unavailable | Accepted |
| [0032](adr/0032-recommendations.md) | Recommendations: search order lifted by care team, past visits (date only), profile city and language (lift, never filter) and soonest free time; fact-based explanations and a next step; patient side only; served by the existing read-only assistant tool | Accepted |
| [0033](adr/0033-conversational-clarification.md) | Conversational clarification: the model reports options, removals, "show others" and unsupported preferences; the code decides; explicit structured state (open question, bounded to 2, removed criteria, backend-only exclusions, notices); choices as data; same read-only tools | Accepted |
| [0034](adr/0034-booking-from-the-assistant.md) | Booking from the assistant: exact-time hand-off to the booking page; the patient reviews and confirms there; one booking path (idempotent, eligibility-guarded, paid); no approval table and no write tool | Superseded by 0038 |
| [0035](adr/0035-tamper-evident-audit-and-coverage.md) | Tamper-evident audit log: a keyed hash chain over consecutive settled ranges (HMAC key derived from the clinical data key), verified on demand and by command; audit coverage enforced for every successful mutation in the integration suite, with reasoned exceptions | Accepted |
| [0036](adr/0036-ai-safeguards-budget-and-record-answers.md) | AI safeguards: a mandatory daily ceiling on model spend with an external provider (enforced across replicas from recorded runs); passing failures in document analysis deferred to the job retry, not stored; appointments and medicines shown from the record by the backend, never sent to the AI | Accepted |
| [0037](adr/0037-local-models-ollama.md) | Local models through Ollama: chat (schema-constrained) and embeddings, self-hosted so not external; chunks and profile vectors record their embedding model and are compared only within one; timeout scale for CPU models; code corrects unambiguous words a small model misreads | Accepted |
| [0038](adr/0038-booking-in-the-conversation.md) | Booking in the conversation: taps are code-applied selections; the backend re-checks a picked time and stores a 15-minute proposal; only the person's Confirm books (one booking path, idempotent); doctors may accept new patients automatically (database-enforced); payment, calendar and notifications in the same flow. Supersedes the ADR-0034 hand-off | Accepted |
| [0039](adr/0039-patients-ask-about-their-own-records.md) | Patients ask about their own records: the patient side may use the record-question RAG with their own opt-in (no consent needed for their own documents); Health Records and the assistant answer with citations, the planner never sees the record; vectors of a new embedding model are added beside append-only chunks (`ai.chunk_vectors`), once per worker start or on demand. Amends 0024 and 0036 §3 | Accepted |

Template: Context → Decision → Consequences (→ Alternatives considered).
