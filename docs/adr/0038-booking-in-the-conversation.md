# ADR-0038: Booking in the conversation

- **Status:** Accepted (implemented). Supersedes the hand-off in ADR-0034, which took
  the patient to the booking page to book.
- **Date:** 2026-10-16
- **Builds on:**
  - ADR-0004: AI proposes, backend validates and commits;
  - ADR-0019 and ADR-0020: scheduling and payments;
  - ADR-0029: agentic care assistant;
  - ADR-0030: one eligibility rule.

## Context

Patients found the hand-off of ADR-0034 manual. The assistant suggested doctors and
times, and then the work moved to the booking page. The aim is a complete flow in the
conversation:

1. recommend a doctor;
2. ask for the day and time;
3. book;
4. pay;
5. add the visit to the calendar;
6. notify by email and in the app.

That flow must not let a model book, pay or change anything by itself.

## Decision

1. **Taps are selections, applied by code.** Tapping **Book** on a doctor, or a time, sends
   a structured selection with the message (`select: { kind: 'doctor' | 'slot', … }`).
   - The AI service applies it without a model call, accepting only a doctor it showed or
     a time it offered.
   - The backend keeps only IDs it returned.
   - Words work too: "the second one" picks a shown doctor, "at 10:30" a free time,
     "book Dr. Meera" a named one. The model fills two more form fields for these
     (`pickDoctor`, `time`); code does the matching.
2. **The assistant asks for times.** With a doctor chosen, it looks up free times: the
   asked-for day and window, or otherwise the coming days, two a day. If nothing is free
   that day, it offers the next days. It then asks which time suits.
3. **A picked time becomes a proposal, built by the backend.**
   - The AI step can only return a `booking` card naming a doctor and a time.
   - The backend checks the slot again with the booking rules, as the person's view. If
     the time is gone, it says so.
   - It then stores an `assistant_actions` row: the doctor, time, mode, clinic and fee
     only. The row expires in 15 minutes, belongs to the user (RLS) and is audited
     (`assistant.action_proposed`).
   - The card shows what will be booked, the fee, whether the doctor joins the care team,
     and a reason-for-visit field: the same intake as the booking page, typed into a form
     rather than the chat.
4. **Only the person's Confirm books.**
   - `POST /assistant/sessions/:id/actions/:actionId/confirm` re-checks access (a revoked
     guardianship ends it), then books through `appointmentService.book`. That is the one
     booking path: eligibility guard, overlap constraint, payment hold, outbox.
   - The idempotency key comes from the proposal, so a repeated tap returns the same
     booking.
   - Expired or closed proposals are refused (`409`), and so is someone else's (`404`).
   - The model has no write tool: the five assistant tools stay read-only.
   - A confirmed proposal is finished. On the next turn the backend clears the booking
     doctor and time from the conversation (and its intent), so a new question starts
     afresh instead of offering the booked time again.
5. **The care team, in the same flow.**
   - A doctor can accept new patients automatically (`doctors.accepts_new_patients`,
     set on their profile).
   - Confirming with such a doctor creates an active care relationship first, then books.
     The database enforces this: a patient-initiated relationship starts `pending`, or
     `active` only for such a doctor.
   - Otherwise Confirm sends a care request, and the booking waits for the doctor
     (`awaiting_doctor`).
6. **Payment in the conversation.** A paid time is held (`pending_payment`) and paid in the
   chat with the same checkout as the payment page: Razorpay's window, or the test
   provider in development. The browser never marks anything paid; the verified webhook
   confirms it.
7. **Calendar and notifications.** The confirmation and payment emails carry the calendar
   invitation, and the inbox gets the notice (from the outbox as for every booking). The
   chat shows Google Calendar, Outlook and `.ics` links.

## Consequences

- A patient can go from "a general physician tomorrow evening" to a booked and paid visit
  in the calendar without leaving the conversation. Each irreversible step is a deliberate
  tap on something the backend built.
- The reason for the visit is the only free text, entered in a form field, stored with the
  appointment as on the booking page and shared with the doctor. Chat messages are still
  never stored.
- Proposals are short-lived rows that go with their session (24 hours at most).
- Cancelling and rescheduling stay on the appointment page, each with its own
  confirmation.
