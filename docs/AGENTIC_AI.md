# Agentic AI: the HealthBridge Assistant

The working guide to M13. The decision record is [ADR-0029](adr/0029-agentic-ai-orchestration.md).

**The principle:** the AI is the planner; the backend is the authority; PostgreSQL is the source of truth. The assistant is a workflow helper. It never diagnoses, prescribes, changes treatment or decides urgency.

## Status by sub-phase

| Phase | Scope | Status |
|---|---|---|
| **M13.1** Foundation | Sessions, the bounded graph, read-only tools, safety check, Assistant page | Done |
| **M13.2** Doctor search | Shared specialty terms and areas of practice; one SQL search with eligibility, specialty, city, language, mode and name filters; deterministic ranking with reasons; no-match told apart from search unavailable (ADR-0031). Vector ranking added on top. | Done |
| **M13.3** Recommendations | Search order lifted by care team, past visits, profile city and language, and soonest free time; fact-based explanations and next steps; patient side only; served by the existing read-only `searchDoctors` tool and the My Doctors page (ADR-0032) | Done |
| **M13.4** Appointment orchestration | Slot cards and recommendations hand the exact time to the booking page; the patient reviews and confirms there (one idempotent, eligibility-guarded, paid booking path; no write tool) (ADR-0034) | Done |
| M13.5 | Booking in the conversation (ADR-0038): choose a doctor and a time, confirm, pay, calendar. Reschedule and cancel stay on the appointment page, each with an explicit confirmation; the assistant shows the upcoming appointments and links to each | Done |
| Step 10 | Answers from the record (upcoming appointments, medicines on recent signed prescriptions), shown by the backend and never sent to the AI; daily spend ceiling; deferred document analysis on passing failures (ADR-0036) | Done |
| M13.6–M13.7 | Calendar adapter, medication schedule and reminders | Later |

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
   2. loads the session (RLS: own sessions, for a patient on the user's side);
   3. re-checks the patient scope with AccessPolicy;
   4. screens the message with the shared emergency rule. A possible emergency gets the fixed 112/108 guidance from the backend itself, and the turn ends there: no AI-service call, no tool and no booking flow, so the guidance survives an AI outage, a timeout or a failed AI run-record write. It is not blocked by a stale version or the turn limit;
   5. checks the version and the turn limit.
3. The backend sends the AI step the message, its keyed digest (HMAC-SHA256 under a backend-only key, for the run record), the current state and a **calendar context**: today, tomorrow, the next weekdays and the horizon, computed by the backend in the person's time zone, plus the specialty list.
4. The graph runs:
   - `safety`: possible emergency → fixed guidance, done (a second line: the backend already screened the message with the same rule);
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
| `criteria` | `specialty` (allowed list), `areas` (up to 3 areas of practice that fit the specialty, M13.2), `consultationMode`, `date` (resolved ISO day), `timeWindow`, `language`, `city`, `doctorName` |
| `specialtyFromConcern` | The specialty was inferred from a described concern (shows "Skin concerns are usually seen by dermatologists."). A flag only. |
| `careTeamDoctorIds`, `candidateDoctorIds`, `selectedDoctorId`, `slotStarts` | References that backend tools returned |
| `lastTools` | Tool names used in the last turn |
| `pendingChoice`, `clarifyTurns` | An open question ("which kind of doctor?") with 2 or 3 options; at most 2 questions in a row, then the assistant searches (ADR-0033) |
| `removed` | Criteria the person said they do not mind ("any city"); they are not used again until stated again |
| `excludedDoctorIds` | Doctors not to show again ("show me others"): only IDs the backend showed before, at most 20 |
| `notices` | Preferences from the latest message that cannot be searched (gender, age, fees, ratings, insurance, other), answered honestly |

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
| `searchDoctors` | `specialty?`, `areas?`, `city?`, `language?`, `mode?`, `name?` (none: any eligible doctor) | `doctors:read` | `{ status: 'ok' or 'no_match', doctors: [{ doctorId, specialty, languages, modes, inCareTeam, reasons }] }`, at most 10. A failed search is `search_unavailable`. |
| `getDoctorProfile` | `doctorId` | `doctors:read` | `{ doctorId, specialty, languages }` |
| `findAvailableSlots` | `doctorId`, `date?`, `timeWindow?`, `mode?` | `doctors:read` | `{ doctorId, slots: [{ startsAt, mode }] }`, at most 6, filtered to the local day and window |

Rejected calls never throw. They come back as error codes:

| Error code | When |
|---|---|
| `tool_unknown` | The tool isn't on the allow-list |
| `tool_invalid_arguments` | Arguments fail the strict schema (for example, a `patientId`) |
| `tool_forbidden` | The user lacks the permission |
| A domain code, such as `not_found` | The domain service refused |
| `search_unavailable` | The doctor search itself failed. The assistant says so; it never reports this as "nobody matches". |
| `tool_failed` | An unexpected failure |

## Who may use it

| Role | Access |
|---|---|
| A patient | For themselves |
| A guardian | For a dependent they guard; `view` and `manage` scopes can use the assistant. Booking for a dependent requires `manage`. |
| Doctors, clinic admins, platform admins, support | Refused: no `assistant:use` |

## Booking in the conversation (ADR-0038)

1. **Choose a doctor:** tap **Book** on a doctor card, or say "the second one" or "book
   Dr. Meera".
2. **Choose a time:** the assistant offers free times (the asked-for day and window, or the
   coming days). Tap one, or say "at 10:30".
3. **Check and confirm:** the backend re-checks the time and shows a booking card with the
   doctor, time, mode, clinic, fee and whether the doctor joins the care team, plus a
   reason-for-visit field. Nothing is booked until **Confirm booking**.
4. **Pay** (paid times): in the chat, with the same checkout as the payment page.
5. **Calendar and notices:** the confirmation email carries a calendar invitation, the
   inbox gets the notice, and the chat shows Google Calendar, Outlook and `.ics` links.

Taps are structured selections applied by code (no model call). The model has no write
tool; only the confirm endpoint, called by the person's tap, books (idempotently, through
`appointmentService.book`). A doctor who accepts new patients automatically joins the
care team on Confirm; otherwise a care request is sent and the booking waits for them.
Booking for a dependent needs a `manage` guardianship (the appointment service checks it).

## Answers from the record (step 10, ADR-0036)

| Intent | What the reply carries | Read through |
|---|---|---|
| `view_appointments`, `reschedule`, `cancel` | Up to 3 upcoming appointments: doctor, time, mode, status, and a link to each appointment page (where reschedule and cancel ask for confirmation) | `appointmentService.listForPatient` |
| `view_medications` | The medicines of up to 2 signed prescriptions from the last 90 days, each line exactly as signed, with "ask your doctor before changing or stopping a medicine" | `prescriptionService.listForPatient` |

- The AI only classifies the intent. The backend reads the facts **after** the AI step, as
  the session's user and for the session's patient, with the pages' permission,
  relationship and RLS checks.
- Nothing about appointments or medicines is sent to the AI service, stored in the
  session, or written to the audit log (it records the card count only).
- Cards are typed `appointment` and `medication` with `source: 'record'`. The page
  shows them under "From your records", apart from the reply's "AI suggestion" badge.
- A degraded turn (AI unavailable) carries no record cards. Its fallback links still
  work.

## Record questions (RAG)

Free-text questions about documents and results are answered by the patient-scoped RAG
(ADR-0024) for consented treating doctors, with citations and the exact fallback
"Insufficient information. Please consult the doctor." In the assistant, `ask_records`
points to Health Records. Answering patients' free-text record questions in the assistant
would send clinical text to the model; that stays a separate decision under ADR-0008.

## Failure states

| Failure | What the person sees | System behaviour |
|---|---|---|
| Possible emergency wording | Fixed 112/108 guidance | Backend, before any AI-service call (works with the AI service down) |
| LLM down, timeout, refusal, malformed output | "I couldn't understand that just now / isn't available…" plus My Doctors | `degraded: true`, metric `healthbridge_agent_failures_total` |
| Tool error | A fallback reply | The error code goes to the AI; nothing leaks |
| Tool loop | A fallback after 3 rounds | `tool_limit` |
| Stale or concurrent turn | "This conversation changed in another window" | `409 assistant_session_changed` |
| Session ended, expired or too long | "Start a new conversation" | `409 assistant_session_ended` / `assistant_turn_limit` |
| Guardianship revoked | Refused | AccessPolicy on the next turn |
| Assistant can't start | "Find a doctor in My Doctors" | The rest of the app works normally |
| Daily model budget reached (ADR-0036) | The same fallback as "LLM down" | The AI service refuses the call before the model (`budget_exhausted`). The alert `LlmDailyBudgetReached` fires; service resumes at 00:00 UTC. |

## Tests

| Layer | File | Covers |
|---|---|---|
| AI (pytest, fake model) | `ai-service/tests/test_care_assistant.py` | The bounded tool sequence, no message text in state, reply or run, no free model text reaching the person, emergency without a model call, the run record keeps the backend's keyed digest (never the text or a plain SHA-256), prompt injection, forged IDs, malformed output, LLM down, values outside the form, tool failure, refinement across turns, dependent wording, scope purpose and patient, strict state |
| AI evaluation | `ai-service/tests/test_care_eval.py` | A synthetic set: intent, specialty, day and window accuracy at 90% or more; emergency recall 100%; no diagnostic wording |
| Backend unit | `backend/tests/unit/assistant.test.js` | Calendar in the person's time zone, tool registry (session patient only, strict arguments, permission, error mapping), state contract |
| Backend unit (safety) | `backend/tests/unit/assistantSafety.test.js` | The shared emergency rule mirrors the AI service's exactly; emergency guidance with the AI service unconfigured, unavailable, timing out or failing, with a stale version or a failed write; the keyed digest and its derived key |
| Backend integration | `backend/tests/integration/assistant.test.js` | The loop with a scripted planner, grounded cards, no text in the database or audit, argument manipulation, unknown and write tools, forged state and cards, AI down, malformed or looping, version conflicts, RLS between users, RLS against unrelated patients and revoked guardianships, view-only guardians, emergencies answered without the AI service, the keyed message digest, admin and support refused, end, expiry and purge |
| Frontend | `frontend/src/features/assistant/assistant.test.jsx` | AI versus confirmed labelling, booking links to the existing flow, emergency and degraded replies, ended-session recovery, start-failure fallback, switching between self and a dependent (fresh session and version, nothing leaks, late replies dropped) |
| E2E | `e2e/tests/assistant.spec.js` | The real stack with the fake model: ask, grounded suggestions, existing booking page, emergency guidance |
| Route security | `backend/tests/integration/routeSecurity.test.js` | The new routes deny anonymous access (automatic) |
| Answers from the record (step 10) | `backend/tests/integration/assistantRecords.test.js` | Upcoming appointments and recent signed medicines shown for the session patient only; nothing of them sent to the AI or audited; none on a degraded turn |
| Spend ceiling (step 10) | `ai-service/tests/test_budget.py`, `test_config.py`, `test_db_rls.py` | Refused at the ceiling without calling the model; other replicas counted after a refresh; a new UTC day starts over; required with an external provider and priced models; the total spans patients but reveals only a number |
| Deferred analysis (step 10) | `ai-service/tests/test_documents.py` | An outage, timeout, rate limit or ceiling stores nothing and answers 503; the retry succeeds |

## Running it

- **Default:** it works with the deterministic fake model (`LLM_PROVIDER=fake`).
- **With Claude:** set `LLM_PROVIDER=claude` and `ANTHROPIC_API_KEY`. Synthetic data only; production still needs `LLM_EXTERNAL_PROCESSING_APPROVED=true` after a compliance review (ADR-0008).
