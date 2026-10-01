# ADR-0019: Scheduling: on-demand slots, care-team booking, appointment lifecycle

- **Status:** Accepted (implemented in M3)
- **Date:** 2026-10-02
- **Refines:** proposal §3.2 (`clinic_slots` materialised by a generation job)

## Context

The proposal sketched materialised slot rows produced by a background job. That
requires worker infrastructure before any consumer needs it. It also creates a second
copy of availability that drifts whenever rules change.

## Decision

**Availability**
- Doctors publish weekly rules: weekday, local start and end times, slot length, IANA
  timezone, validity dates, mode (online or in-clinic), clinic and fee. In-clinic rules
  require an active clinic membership.
- Rules for one doctor may not overlap in time, whatever the mode (a doctor cannot be in
  two places).
- Time off (`availability_exceptions`) blocks new slots. It reports clashing appointments
  but does not cancel them automatically: the doctor decides.

**Slots are computed on demand** (`scheduling/domain/slots.js`, pure and unit-tested):
- slots = rule occurrences − time off − busy time;
- at least 30 minutes ahead, at most 60 days ahead;
- results are returned in UTC.

Busy time comes from `authz.doctor_busy_ranges()`, which returns time ranges only and
never patient data.

**The database is the authority against double booking**, through two `EXCLUDE`
constraints on active appointments:
- `(doctor_id, during)`: no doctor double booking;
- `(patient_id, during)`: no patient double booking.

Booking validates that the requested start is an offered slot, then inserts. A
concurrent loser gets `409 slot_unavailable`. A test fires 6 parallel bookings for one
slot and exactly one succeeds.

**Continuity first.** Booking requires an **ACTIVE care relationship** between the
patient and the doctor. Patients (or managing guardians) book from their care team.

**Holds and fees**
- A fee of 0 makes the booking `confirmed` immediately.
- A fee above 0 makes it `pending_payment` with a **15-minute hold**. Payment arrives in M4.
- Stale holds are expired lazily inside the next booking transaction for that doctor
  (`authz.expire_stale_holds`), so they never block slots. A scheduled sweep comes with
  the workers in M4.

**Lifecycle:** see `domain/appointmentStateMachine.js`. Each action has party rules and
time rules:

| Action | Who | When |
|---|---|---|
| Cancel | Patient | Before the start |
| Cancel | Doctor or clinic | Any time |
| Reschedule | Patient | Before the start; atomic cancel + rebook, keeping the reason and `rescheduled_from_id` |
| Check-in | Doctor or clinic | In-clinic visits, from 60 minutes before the start |
| Complete | Doctor | After the start |
| No-show | Doctor or clinic | From 15 minutes after the start |

**Idempotency:** an `Idempotency-Key` per booking user. A replay returns the original
appointment (`200`, `Idempotent-Replayed: true`). Reusing a key with a different payload
returns `409`.

**Privacy**
- The reason for visit is stored in `appointment_intakes`. RLS allows only the patient
  side and the doctor; clinic staff never see it.
- Clinic schedulers see appointments at their clinic (RLS `authz.is_clinic_manager`)
  with a **booking reference** instead of patient identity. Patients identify themselves
  at the desk with that reference.
- The doctor's schedule resolves patient identity per patient through AccessPolicy
  (treating doctor plus consent basis).
- A treating doctor cannot list a patient's appointments with other doctors: there is no
  consent basis for that (403).

**Outbox:** every appointment change writes an `outbox_events` row (identifiers only) in
the same transaction. The relay to BullMQ arrives with its first consumer (payments, M4).

## Consequences

- No slot-generation job. Rule changes take effect immediately.
- Slot listing costs a few indexed queries per request. Results are bounded (31-day
  query window).
- Paid availability can be configured now, but those bookings cannot be completed until
  payments exist (M4). Holds expire after 15 minutes.
- Clinic desk check-in relies on booking references until a consent-based model for
  clinic access to patient identity exists (M5).
