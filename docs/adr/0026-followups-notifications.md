# ADR-0026: Follow-ups, rule-based escalation and the in-app inbox

- **Status:** Accepted
- **Date:** 2026-10-03
- **Builds on:** ADR-0020 (outbox, notifications), ADR-0025 (consultation outcomes), ADR-0011 (bounded agents)

## Context

After a consultation the doctor often wants to know how the patient is doing. The patient
must be able to answer easily. A worrying answer must reach the doctor quickly, and a
dangerous answer must reach the patient with emergency instructions at once.

Two things must never happen:

- the system decides on care;
- AI judges urgency.

## Decision

### Follow-ups

- **Creation:**
  - **From an outcome:** outcome A with a follow-up date creates one follow-up through
    the `followups` queue (`consultation.completed`). The follow-up is unique per
    consultation, so replays are harmless.
  - **By the doctor:** the treating doctor (`followups:manage`, active care
    relationship) can schedule one for any date from today.
- **Sweep:** a maintenance job runs every minute in system purpose `followups`. The
  database is the source of truth. The sweep:
  1. opens check-ins whose date (IST) has come (`awaiting_response`);
  2. writes **durable outbox events** for reminders: at most two, 48 hours apart;
  3. after **7 days** with no answer, moves the follow-up to `needs_attention`
     (`no_response`) and alerts the doctor.
- **Answer:** the patient side answers once (`followups:respond`; guardians need
  `manage` scope). The answer has three parts:
  - how they feel (better / same / worse);
  - a fixed checklist of warning signs;
  - an optional note, envelope-encrypted (AES-256-GCM, bound to the response and
    patient).
- **Escalation is deterministic and shared** (`evaluateFollowUpResponse`):

  | Answer | Result |
  |---|---|
  | Any warning sign | **`urgent`**: fixed emergency guidance (112 / 108) is shown immediately, and the doctor gets an urgent inbox entry and email |
  | "Worse" | `needs_attention`: doctor notice |
  | Anything else | `responded`: no alert |

- **Closing:** the doctor closes (or cancels) the follow-up, and that is final.
- **Database guards:** a trigger lets the patient side change only its answer fields,
  and only while the check-in is open. Identity never changes. `DELETE` is revoked.

### Bounded follow-up agent

- The AI service (`/v1/followups/summary`, purpose `follow_up_summary`) restates the
  check-in for the doctor from backend-provided, labelled facts: feeling, warning signs,
  note and due date.
- It is a LangGraph workflow with no tools: generate, then validate with the same rules
  as ADR-0024 (citations, numbers, lexical support, unsafe-language filter).
- It is **informational only**:
  - it runs after the rule-based escalation;
  - it is shown only to the doctor, labelled AI-generated;
  - it never contacts the patient;
  - it requires the patient's AI opt-in.
- Runs are recorded in `ai_runs` / `ai_sources` (`follow_up_response`), with no content
  in logs.

### In-app inbox

- Every templated notification (M4–M10) also creates an `inbox_notifications` row for each
  recipient:
  - **title:** the subject;
  - **body:** the template's generic first paragraph;
  - **link:** an app path only;
  - **priority:** `urgent` for emergency guidance and urgent follow-ups.
- Rows are idempotent by dedupe key.
- RLS limits the inbox to its owner. A trigger lets owners change only `read_at`, and
  `DELETE` is revoked.
- Every role has `notifications:read`.
- **No clinical content in notices:** no symptoms, warning signs, notes, medicines or
  diagnoses. The doctor sees the patient's name only in notices about their own follow-up.

### Timeline

- Follow-up state appears on the timeline: scheduled / due / answered / needs review /
  urgent / closed. Cancelled follow-ups are hidden.
- Provenance is `doctor_reported` until the patient answers, then `patient_reported`.
- Answers and notes never appear on the timeline.

## Consequences

- Escalation is predictable, testable and explainable, but deliberately coarse. A
  clinically validated questionnaire per condition would be a later, reviewed addition.
- Reminders arrive up to one sweep interval late, and after an outage they converge, but
  never more than twice per follow-up.
- Notices are durable through the outbox, so a Redis outage delays them but does not lose
  them.
- There is no SMS to doctors yet: doctor contact numbers are not collected.
