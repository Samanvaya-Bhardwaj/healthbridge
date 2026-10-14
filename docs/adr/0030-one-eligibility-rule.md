# ADR-0030: One eligibility rule for search, slots and booking

- **Status:** Accepted
- **Date:** 2026-10-15
- **Builds on:**
  - ADR-0019: scheduling with on-demand slots, where the EXCLUDE constraint is the
    authority against overlaps;
  - ADR-0005: transactional outbox;
  - ADR-0020: payments, where a non-patient cancellation is refunded in full.

## Context

Whether a doctor could be booked was decided in three places, and none of them used the
same rule:

- **The directory** checked the doctor's profile and verification.
- **Slots and booking** checked the same in JavaScript, after loading the row.
- **Nothing** checked the doctor's user account. A disabled doctor stayed listed and
  bookable.
- **Availability rules** at a clinic kept producing slots after the clinic was made
  inactive, or after the doctor's membership there ended.
- **Future bookings** were left as they were when any of this changed.

A closure that raced a booking could also let one through.

## Decision

1. **One definition, in PostgreSQL** (migration `20261015000000_practice_eligibility`):
   - `authz.doctor_is_bookable(doctor)`: the profile is active and verified, the account
     is active, and neither is deleted.
   - `authz.practice_site_open(doctor, clinic)`: there is no clinic (online practice), or
     the clinic is active and the doctor's DOCTOR membership there is active.

   The directory, public profile, slot generation (through the availability rules) and
   booking all call these. There is no second copy in application code.
2. **The database decides at booking time.** The `appointments_eligibility_guard` trigger
   (BEFORE INSERT) re-checks both rules and reads the doctor, user, clinic and membership
   rows `FOR SHARE`. A change to any of those rows therefore waits for a booking in
   flight to commit, or commits first and the booking is refused. The API maps a refusal
   to `409 doctor_unavailable` or `409 practice_site_closed`.
3. **Future bookings that stop being eligible are withdrawn by the system.** A change
   that can cause this records `practice.changed` in its own transaction. The changes are:
   - a clinic made inactive;
   - a DOCTOR membership ended;
   - a doctor suspended;
   - an account disabled.

   The appointments worker then runs `appointmentService.withdrawIneligible`. It cancels
   as the `system` party, with reason `clinic_closed` or `doctor_unavailable`. That gives
   a full refund through the existing payments path and the patient notice
   `appointment_withdrawn`. A periodic `eligibility-sweep` runs the same function as a
   safety net, for example after a change made outside the app. Both are idempotent.
4. **Stale slots in the browser:** when a booking gets one of the stale-slot conflicts
   (`slot_unavailable`, `slot_not_offered`, `practice_site_closed` or
   `patient_double_booked`), the booking page explains it, refreshes the free times and
   clears the choice.

## Consequences

- One rule is tested in one place. Integration tests cover the disabled account, the
  closed clinic, a doctor leaving a clinic, a doctor's suspension, a booking that
  bypasses the application check, and a closure that waits for an in-flight booking.
- Bookings briefly take share locks on four small rows. A profile edit can wait a few
  milliseconds for a booking in flight.
- `SECURITY DEFINER` functions are used because `FOR SHARE` needs UPDATE privilege. They
  run with a fixed `search_path`, as the other `authz` functions do.
- A booking withdrawn by the system cannot be undone. The patient books again.

## Alternatives considered

- **Application checks only:** they cannot close the race with a concurrent closure.
- **Cancelling inside the closing transaction:** this mixes clinic administration with
  patient appointments and payments under one transaction and RLS context. The outbox
  keeps them separate and retryable.
- **Hiding ineligible doctors but keeping their bookings:** patients would turn up to a
  closed clinic.
