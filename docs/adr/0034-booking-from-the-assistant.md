# ADR-0034: Booking from the assistant (M13.4)

- **Status:** Accepted (implemented). This refines the M13.4 plan in ADR-0029.
- **Date:** 2026-10-16
- **Builds on:**
  - ADR-0029: agentic care assistant;
  - ADR-0019: scheduling;
  - ADR-0020: payments;
  - ADR-0030: one eligibility rule;
  - ADR-0032: recommendations.

## Context

ADR-0029 planned M13.4 as "pending approval → explicit confirmation →
`appointmentService.book`", with an `agent_actions` approval table and booking-related
tools. Two things changed since:

- The approved tool set is five read-only tools, and the delivery plan keeps the
  assistant out of any write path.
- The booking page already has a review step, the cancellation and refund policies, an
  explicit confirmation, an idempotency key and payment. Every server-side rule (care
  relationship, eligibility guard, overlap constraint) applies to it.

A second write path would duplicate all of that.

## Decision

1. **The assistant proposes; the patient confirms on the booking page.** Assistant slot
   cards and recommendations link to the booking page with the exact doctor, patient,
   consultation type and time (`startsAt`). The page preselects that time while it is
   still free, and says so when it has gone. Nothing is booked until the patient reviews
   the summary and clicks to confirm. The "pending approval" of ADR-0029 is this review
   step: there is no `agent_actions` table and no write tool.
2. **One booking path.** `appointmentService.book` runs with the page's idempotency key.
   It applies the care relationship check, the eligibility guard (ADR-0030), the overlap
   constraint and payment. A stale slot gets the same answer as any other (refresh and
   choose again).
3. **Reliable updates use the existing machinery:**
   - booking, payment required, payment confirmed or failed, refund, cancellation,
     reschedule and withdrawal notices come from the outbox, by email and in the in-app
     inbox;
   - the appointment page refreshes while a payment is pending;
   - a booking withdrawn by the system says why ("the clinic has closed") and that any
     payment is refunded in full.
4. **Reschedule and cancel (M13.5)** stay on the appointment page, where both need an
   explicit confirmation. The assistant links there.

## Consequences

- The assistant never holds a write capability. Prompt injection cannot book, cancel or
  pay.
- Booking from the assistant takes one more click than a hypothetical in-chat
  confirmation. In exchange, the confirmation is the same reviewed page everyone uses.
- M13.6 (calendar adapter) and M13.7 (medication reminders) remain later phases.

## Alternatives considered

- **An approval table with a confirm endpoint:** a second write path with the same
  checks. More code, more risk, no user benefit.
- **Letting the model call `book` after a "yes" in chat:** this puts the model in the
  write path. Rejected (ADR-0004).
