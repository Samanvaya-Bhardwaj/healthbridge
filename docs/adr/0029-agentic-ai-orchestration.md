# ADR-0029: Agentic AI care orchestration (M13)

- **Status:** Accepted (M13.1 implemented; M13.2–M13.7 build on it)
- **Date:** 2026-10-09
- **Builds on:**
  - ADR-0001: modular monolith with a private AI service;
  - ADR-0004: AI proposes, the backend validates and commits;
  - ADR-0005: transactional outbox;
  - ADR-0006 and ADR-0017: three-gate access and RLS;
  - ADR-0008: LLM and PHI policy;
  - ADR-0011: bounded agents;
  - ADR-0012: AI execution records;
  - ADR-0019: scheduling;
  - ADR-0024: patient-scoped RAG.

## Context

Patients reach care through several pages: My Doctors, booking, Appointments and Privacy & Access. Someone who just wants "a dermatologist tomorrow evening" has to know which page does what.

An assistant that understands a request in plain words, and orchestrates the existing workflows, can make the platform easier to use. Healthcare raises the stakes:

- **No clinical role:** the assistant must never diagnose, prescribe or judge urgency.
- **No new authority:** it must never act outside the patient's own permissions and consent.
- **No hidden record:** it must never turn a chat into a medical record.
- **No escape route:** it must never become a way to bypass AccessPolicy, RLS or the booking rules.

## Decision

### 1. A planner over backend tools, not an autonomous agent

- **The planner proposes, the backend acts.** The AI service hosts a fixed LangGraph graph that decides the *next step* of a turn. The backend owns the turn loop and executes every tool.
- **One-way calls.** The AI service never calls the backend. It holds no tools, no user credentials and no access to `public`.
- **One step per call.** Each call to the internal `POST /v1/agent/step` carries the message, or a tool result. The graph returns the updated structured state and the next action: one backend tool to run, or a reply.

```
browser ─► POST /api/v1/assistant/sessions/:id/messages
             backend: authenticate → assistant:use → patient scope (AccessPolicy)
               ├─► AI step (message) ──────► { state, action: tool X }
               ├─► run tool X through the existing domain service (AccessPolicy, RLS)
               ├─► AI step (tool result) ──► { state, action: tool Y | respond }
               └─ … at most 3 tool rounds …
             backend: validate state → build cards from backend data → commit (version check)
```

### 2. The graph

```
START ─┬─(tool result)─► observe ──────────────────────────► route ─► END
       └─(message)────► safety ─┬─(possible emergency)─► END
                                └─► understand ─► validate ─► route ─► END
```

| Node | What it does |
|---|---|
| **`safety`** | Deterministic. Wording that may signal an emergency gets fixed 112/108 guidance, with no model call and no booking prompt. This is not triage: clinical urgency stays with the rule-based follow-up escalation and the doctor. |
| **`understand`** | The only model call: the fast tier, with structured output. It fills a fixed form: an intent enum, a specialty from the backend's list, a consultation mode, a day reference, a time window, a language, a city and a doctor's name. The message is delimited as untrusted data. |
| **`validate`** | Keeps only enum values, allowed specialties, regex-checked names, and days the backend resolved in the person's time zone (today, tomorrow, weekdays, horizon). Anything else is dropped. Malformed output leads to a fallback reply. |
| **`route`** | Deterministic. Composes the next tool and its arguments **in code, from validated state**: the care team, then search, then slots. The model never writes tool arguments, never sees a patient identifier and cannot add tools. |
| **Replies** | Fixed templates. Cards reference only IDs that backend tools returned. |
| **Limits** | 3 tool rounds per turn, 1 model call per message, 300 output tokens, a 20 s step timeout and 40 turns per session. |

### 3. Tools

The backend keeps an explicit allow-list, so the AI can't add tools:

| Tool | Calls | Permission |
|---|---|---|
| `getPatientContext` | Session context | `assistant:use` |
| `getPatientCareTeam` | `careService.listForPatient` | `care_relationships:read` |
| `searchDoctors` | `doctorService.directory` | `doctors:read` |
| `getDoctorProfile` | `doctorService.publicProfile` | `doctors:read` |
| `findAvailableSlots` | `availabilityService.slots` | `doctors:read` |

How the backend handles each tool call:

- **Arguments:** checked with strict Zod schemas, so unknown keys are refused, and `patientId` is never accepted.
- **Identity and scope:** every tool runs as the signed-in user, against the session's patient. Results sent back to the AI hold IDs and public doctor facts only.
- **Failures:** unknown tools, bad arguments, missing permissions and domain errors become `{ ok: false, errorCode }` results, never exceptions or leaks.
- **Write tools (M13.4):** booking-related tools will create *pending approvals* only. The commit runs after explicit confirmation by the patient, through `appointmentService.book` with a deterministic idempotency key. Booking keeps every existing rule:
  - an active care relationship is required;
  - EXCLUDE constraints prevent double booking;
  - payment holds, with webhook-only payment authority;
  - outbox notifications.

### 4. State: bounded, structured, short-lived

- **What is stored.** `agent_sessions` (PostgreSQL) holds `CareAssistantState` only:
  - the intent;
  - non-diagnostic criteria;
  - a flag saying the specialty was inferred from a described concern;
  - doctor and slot IDs returned by backend tools;
  - the tools used.
- **What is not stored.** No message text and no transcript: the browser keeps the visible conversation.
- **Validation and size.** State is validated with a strict shared schema on every write, so unknown keys such as `patientId` are rejected. It's capped at 16 KB and expires 24 hours after creation; the existing maintenance sweep deletes it (system purpose `assistant`).
- **AI run records.** Each message has an `ai.ai_runs` record with metadata and a SHA-256 hash of the message, never the text.
- **Not a medical record.** Nothing in a chat becomes part of the medical record.

### 5. Security boundaries

1. **Scope.** The patient scope is fixed when the session is created: self, or a dependent through an active guardianship. AccessPolicy re-checks it on every turn, so a revoked guardianship ends access at once. Only `patient_self` and `guardian_dependent` relationships may use the assistant. Doctors, clinic staff, platform admins and support have no `assistant:use` permission.
2. **RLS.** Sessions are visible only to their user: SELECT, INSERT and UPDATE are restricted to the owner, and only the sweep can DELETE.
3. **Consent.** All patient-data access stays behind AccessPolicy and RLS through the existing services. Record and medication tools (later phases) inherit consent checks unchanged.
4. **Untrusted AI output.** The backend validates the returned state and the reply shape. It drops doctor and slot IDs it didn't produce, and builds every card from its own evidence.
5. **The AI service** stays internal (service JWT plus a patient-scope token with purpose `care_assistant`). `hb_ai` gets no new grants.
6. **Logging.** Logs and metrics are metadata only: intents, tool names, outcomes and timings. Message text, replies and criteria values are never logged or audited.

### 6. Scaling and concurrency

- **Stateless workers.** The API and AI service hold no state between calls, so any instance can serve any turn.
- **Optimistic concurrency.** Turns use the session `version`: a stale or concurrent turn is refused with `409 assistant_session_changed`. No transaction stays open during model calls.
- **Redis** is used only for the per-user rate limit (120 turns per hour).

### 7. Failure handling

If the LLM is unavailable, times out, returns malformed output, loops on tools, or a tool fails, the turn degrades:

- the reply is a fallback pointing to My Doctors;
- `degraded: true` is set and the failure is counted in metrics;
- the session still advances;
- the rest of the platform is unaffected.

### 8. Observability

Backend metrics:

- `healthbridge_agent_runs_total{intent,outcome}`;
- `healthbridge_agent_tool_calls_total{tool,outcome}`;
- `healthbridge_agent_failures_total{kind}`;
- `healthbridge_agent_latency_seconds{outcome}`;
- `healthbridge_agent_tool_latency_seconds{tool}`.

AI service:

- `ai_agent_steps_total{workflow,action,outcome}`;
- the existing LLM call, token and cost metrics, under workflow `care_assistant_intent`.

Audit records: `assistant.session_started` and `assistant.turn`, holding the intent, tool names and card count.

## Why these choices

- **LangGraph** gives an explicit graph with typed state and conditional edges, the same pattern as the existing document, brief and follow-up agents (ADR-0011). It needs no checkpointer here, because the backend persists the state.
- **The AI service stays separate:**
  - it keeps the existing isolation (its own credentials, no `public` access, an internal network);
  - it keeps the provider abstraction and the external-LLM approval gate (ADR-0008);
  - one place holds all model calls, metrics and cost control.
- **The AI never writes to the database:**
  - every state change goes through domain services that already enforce authentication, AccessPolicy, consent, business rules, transactions, audit and the outbox;
  - a model that wrote directly would bypass all of them, and a prompt injection could become a data change.
- **No microservice:** the assistant is a backend module, consistent with the modular monolith.

## Alternatives considered

- **The AI service calls backend tools over HTTP.** Rejected. It would need user-level credentials and a new network path from the AI service to the API, and it would let a manipulated model drive actions.
- **A free-form tool-calling agent:** the model chooses tools and writes their arguments. Rejected for M13: it is harder to bound, test and audit, and deterministic routing is enough for these workflows.
- **Storing transcripts for context.** Rejected. Transcripts would be PHI with no clinical purpose; structured state carries everything the workflow needs.
- **A Redis checkpointer.** Rejected. Redis isn't a source of truth here, and PostgreSQL gives RLS and retention.

## Consequences

- The assistant can only do what the existing services allow the same user to do.
- M13.1 is read-only. Booking (M13.4) adds an `agent_actions` approval table and the confirmation flow in its own migration.
- Rescheduling and cancelling (M13.5), calendar sync (M13.6) and medication reminders (M13.7) arrive as further tools and graph routes. Each comes with its own tests and documentation.
