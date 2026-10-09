# Agentic AI: the HealthBridge Assistant

The working guide to M13. The decision record is [ADR-0029](adr/0029-agentic-ai-orchestration.md).

**The principle:** the AI is the planner; the backend is the authority; PostgreSQL is the source of truth. The assistant is a workflow helper. It never diagnoses, prescribes, changes treatment or decides urgency.

## Status by sub-phase

| Phase | Scope | Status |
|---|---|---|
| **M13.1** Foundation | Sessions, the bounded graph, read-only tools, safety check, Assistant page | Done |
| M13.2 Semantic doctor search | Hybrid metadata, full-text and pgvector search over public doctor profiles; transparent ranking | Planned |
| M13.3 Recommendations | A small ranked list with grounded explanations | Planned |
| M13.4 Appointment orchestration | Pending approval → explicit confirmation → `appointmentService.book` (idempotent), existing payment and notifications | Planned |
| M13.5–M13.7 | Reschedule and cancel, calendar adapter, medication schedule and reminders | Later |

## Where the code is

| Part | Location |
|---|---|
| Shared contracts | `shared/src/domain/assistant.js`: `careAssistantStateSchema`, request schemas, specialties, intents, tool names |
| Graph | `ai-service/app/agents/care_assistant.py`, prompts in `care_prompts.py`, safety in `care_safety.py` |
| Internal endpoint | `ai-service/app/api/agent.py`: `POST /v1/agent/step` |
| Fake model | `ai-service/app/llm/care_fake.py` (workflow `care_assistant_intent`) |
| Turn loop | `backend/src/modules/assistant/service.js` |
| Tools | `backend/src/modules/assistant/tools.js` |
| Calendar | `backend/src/modules/assistant/calendar.js`: days and windows resolved in the person's time zone |
| API | `backend/src/modules/assistant/routes.js` |
| Storage | `agent_sessions`, migration `20261013000000_care_assistant` |
| UI | `frontend/src/features/assistant/AssistantPage.jsx` |

## One turn, step by step

1. The browser sends `{ text, version, timeZone }` to `POST /api/v1/assistant/sessions/:id/messages`.
2. The backend:
   1. authenticates and checks `assistant:use`;
   2. loads the session (RLS: own sessions only);
   3. re-checks the patient scope with AccessPolicy;
   4. checks the version and the turn limit.
3. The backend sends the AI step the message, the current state and a **calendar context**: today, tomorrow, the next weekdays and the horizon, computed by the backend in the person's time zone, plus the specialty list.
4. The graph runs:
   - `safety`: possible emergency → fixed guidance, done;
   - `understand`: one fast-tier model call that fills the fixed form;
   - `validate`;
   - `route`: returns either a tool request or a reply.
5. For a tool request, the backend:
   1. checks the arguments strictly;
   2. checks the permission;
   3. runs the tool through the existing domain service as the user, for the session's patient;
   4. sends the AI step the result: `{ ok, data | errorCode }`, IDs and public facts only.

   This repeats for up to 3 rounds.
6. The backend:
   1. validates the final state with the shared schema;
   2. drops doctor and slot IDs it didn't return;
   3. builds the reply cards from its own data;
   4. commits the state with `version + 1` and writes an audit row (metadata only).
7. The browser shows the reply.

   | Label | Meaning |
   |---|---|
   | **AI suggestion** | Suggested by the assistant |
   | **Suggested · not booked** | Free times, not reserved |
   | **What I understood** | The structured criteria, so the person can correct them |
   | **In your care team** / **Not in your care team yet** | Backend facts |

   Booking stays on the existing booking page.

## State (`CareAssistantState`)

| Field | Meaning |
|---|---|
| `intent` | `find_doctor`, `book_appointment`, `view_appointments`, `reschedule`, `cancel`, `ask_records`, `view_medications`, `greeting`, `unsupported` |
| `criteria` | `specialty` (allowed list), `consultationMode`, `date` (resolved ISO day), `timeWindow`, `language`, `city`, `doctorName` |
| `specialtyFromConcern` | The specialty was inferred from a described concern (shows "Skin concerns are usually seen by dermatologists."). A flag only. |
| `careTeamDoctorIds`, `candidateDoctorIds`, `selectedDoctorId`, `slotStarts` | References that backend tools returned |
| `lastTools` | Tool names used in the last turn |

Limits:

- **Strict:** unknown keys are refused.
- **Bounded:** 16 KB in the database.
- **Short-lived:** 24 hours.
- **Text-free:** no message text, no symptoms, no transcript.

## Tools and permissions

| Tool | Arguments (strict) | Permission | Result to the AI |
|---|---|---|---|
| `getPatientContext` | none | `assistant:use` | `{ actingFor }` |
| `getPatientCareTeam` | none | `care_relationships:read` (AccessPolicy on the session's patient) | `{ doctors: [{ doctorId, status }] }` |
| `searchDoctors` | `specialty?`, `name?`, `language?` (one required) | `doctors:read` | `{ doctors: [{ doctorId, specialty, languages, inCareTeam }] }`, at most 10 |
| `getDoctorProfile` | `doctorId` | `doctors:read` | `{ doctorId, specialty, languages }` |
| `findAvailableSlots` | `doctorId`, `date?`, `timeWindow?`, `mode?` | `doctors:read` | `{ doctorId, slots: [{ startsAt, mode }] }`, at most 6, filtered to the local day and window |

Rejected calls never throw. They come back as error codes:

| Error code | When |
|---|---|
| `tool_unknown` | The tool isn't on the allow-list |
| `tool_invalid_arguments` | Arguments fail the strict schema (for example, a `patientId`) |
| `tool_forbidden` | The user lacks the permission |
| A domain code, such as `not_found` | The domain service refused |
| `tool_failed` | An unexpected failure |

## Who may use it

| Role | Access |
|---|---|
| A patient | For themselves |
| A guardian | For a dependent they guard; `view` and `manage` scopes can read. M13.4's booking will require `manage`. |
| Doctors, clinic admins, platform admins, support | Refused: no `assistant:use` |

## Approval flow (M13.4)

Booking will create a pending action, with no write yet. The confirmation summary shows:

- the doctor;
- the date and time;
- the mode;
- the fee;
- the clinic and its address.

After explicit approval, the backend books through `appointmentService.book` with a key derived from the action, so a retried or replayed approval returns the same appointment. The existing hold, payment, webhook and outbox notification flow then applies unchanged.

## RAG integration (later phases)

Record and medication questions will call the existing patient-scoped RAG and structured prescription data (ADR-0024, ADR-0025). That reuse keeps:

- consent checks;
- citations;
- grounding;
- the exact fallback, "Insufficient information. Please consult the doctor."

There will be no second vector store and no duplicate indexing. Until then, those intents point to the existing pages.

## Failure states

| Failure | What the person sees | System behaviour |
|---|---|---|
| Possible emergency wording | Fixed 112/108 guidance | No model call |
| LLM down, timeout, refusal, malformed output | "I couldn't understand that just now / isn't available…" plus My Doctors | `degraded: true`, metric `healthbridge_agent_failures_total` |
| Tool error | A fallback reply | The error code goes to the AI; nothing leaks |
| Tool loop | A fallback after 3 rounds | `tool_limit` |
| Stale or concurrent turn | "This conversation changed in another window" | `409 assistant_session_changed` |
| Session ended, expired or too long | "Start a new conversation" | `409 assistant_session_ended` / `assistant_turn_limit` |
| Guardianship revoked | Refused | AccessPolicy on the next turn |
| Assistant can't start | "Find a doctor in My Doctors" | The rest of the app works normally |

## Tests

| Layer | File | Covers |
|---|---|---|
| AI (pytest, fake model) | `ai-service/tests/test_care_assistant.py` | The bounded tool sequence, no message text in state, reply or run, no free model text reaching the person, emergency without a model call, prompt injection, forged IDs, malformed output, LLM down, values outside the form, tool failure, refinement across turns, dependent wording, scope purpose and patient, strict state |
| AI evaluation | `ai-service/tests/test_care_eval.py` | A synthetic set: intent, specialty, day and window accuracy at 90% or more; emergency recall 100%; no diagnostic wording |
| Backend unit | `backend/tests/unit/assistant.test.js` | Calendar in the person's time zone, tool registry (session patient only, strict arguments, permission, error mapping), state contract |
| Backend integration | `backend/tests/integration/assistant.test.js` | The loop with a scripted planner, grounded cards, no text in the database or audit, argument manipulation, unknown and write tools, forged state and cards, AI down, malformed or looping, version conflicts, RLS between users, guardian scope and revocation, admin and support refused, end, expiry and purge |
| Frontend | `frontend/src/features/assistant/assistant.test.jsx` | AI versus confirmed labelling, booking links to the existing flow, emergency and degraded replies, ended-session recovery, start-failure fallback |
| E2E | `e2e/tests/assistant.spec.js` | The real stack with the fake model: ask, grounded suggestions, existing booking page, emergency guidance |
| Route security | `backend/tests/integration/routeSecurity.test.js` | The new routes deny anonymous access (automatic) |

## Running it

- **Default:** it works with the deterministic fake model (`LLM_PROVIDER=fake`).
- **With Claude:** set `LLM_PROVIDER=claude` and `ANTHROPIC_API_KEY`. Synthetic data only; production still needs `LLM_EXTERNAL_PROCESSING_APPROVED=true` after a compliance review (ADR-0008).
