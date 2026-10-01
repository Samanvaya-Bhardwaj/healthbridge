# ADR-0018: Doctor verification workflow and workflow-granted roles

- **Status:** Accepted (implemented in M2)
- **Date:** 2026-10-01

## Context

Patients must only ever be connected to genuine registered medical practitioners. A
profile existing, or an administrator flipping a role, must never be enough.

## Decision

- **Three separate things:**
  - the **user account** (`users`);
  - the **doctor profile** (`doctors`, professional data, editable by its owner);
  - the **verification** (`doctor_verifications`: one row per case, an immutable
    history of submissions and decisions).
- **State machine** (`modules/doctors/domain/verification.js`):
  ```
  unverified ─submit→ pending ─start_review→ under_review ─decide→ verified | rejected
  rejected ─submit→ pending        verified ─suspend→ suspended ─submit→ pending
  ```
  - At most one open case per doctor (partial unique index).
  - The case stores a snapshot of the registration number, council and year that were
    reviewed.
- **Decisions:**
  - Only platform admins with `admin:doctors` decide, through explicit
    `start-review` → `decision` steps.
  - A reason code is required. Approval uses `credentials_confirmed`; rejection and
    suspension use specific codes.
  - Reviewer notes are internal. They are never copied into the audit log and are hidden
    from the doctor.
  - **Separation of duties:** nobody can review or suspend their own profile.
- **Roles follow decisions, in the same transaction:**
  - approval grants `DOCTOR` and activates the profile;
  - suspension revokes `DOCTOR` and hides the profile.
- **Constraints:**
  - The database forbids an active profile unless verified.
  - Registration details are locked while pending, under review or verified.
  - Registration numbers are unique per council.
- **Workflow-granted roles:** `DOCTOR` (only from verification) and `CLINIC_ADMIN` (only
  from clinic appointment) cannot be granted through the generic role endpoint or the
  `create-user` script (`role_requires_workflow`).
- **Who can apply:** any registered user can apply (`doctor_profile:manage` is held by
  PATIENT), because doctors sign up like everyone else.
- **Directory:** the public directory and public profile show only verified, active
  doctors.
- **Audit:** every step is audited: profile create and update, submit, review start,
  decision, suspension.
- **Manual review only:** verification is a manual administrative check against the
  medical council register in M2. No automated or AI credential checks.

## Consequences

- Suspension removes treating access immediately. The relationship resolver requires a
  verified, active doctor, and the role is removed as well.
- Re-verification after suspension goes through the full review again.
- Document upload for credentials (certificates) arrives with the document pipeline.
