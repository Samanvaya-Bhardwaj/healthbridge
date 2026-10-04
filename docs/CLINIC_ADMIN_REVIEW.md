# Clinic administrator experience review

A working session as the demo clinic administrator, in a real browser on the local stack:
- **Data:** three in-clinic visits with Dr. Meera today. One is paid and late (its time has passed without check-in), one is paid and due in 40 minutes, and one is still awaiting payment.
- **Steps:** the overview, then the clinic schedule, then a partial refund, then a check-in, then the clinic team, then two attempts to open clinical pages.
- **Screens:** desktop (1440 px) and mobile (390 px). Synthetic data only.

This phase changed the clinic administrator interface only. The API, schema, permissions and role boundaries are unchanged. One existing API capability, the clinic refund (goodwill, charged twice, other), is now offered in the interface; before, no screen called it.

## Role boundary checks

- **No clinical endpoints:** the browser made 45 API calls in the session, none to a clinical endpoint. That covers consultations, prescriptions, documents, timeline, lab results, AI questions, briefs, follow-ups, consents and the access log.
- **Visit reasons never shown:** the visit reason never appeared on screen, and the clinic view of an appointment does not include it.
- **No patient names:** patient identity is not returned to the clinic, so visits show the booking reference, which patients give at the desk.
- **Boundary stated on every clinic page:** "Clinic operations only. You manage schedules, check-ins, payments and the clinic team. Patient names, visit reasons, notes, prescriptions and medical records stay with patients and their doctors."
- **Clinical pages explain the refusal:** opening one (for example a patient record) shows "Clinic operations only" and the reason, with a way back to the clinic overview. Platform administrators, support and doctors get their own explanations.

## What changed

| Area | Before | Now |
|---|---|---|
| Overview | Today's visits as doctor, mode and status. | The clinic's name and date, the boundary note and four counts: visits today, still to come, completed, need attention. Then the sections in [Overview sections](#overview-sections). |
| Clinic schedule | The next 7 days in one list, with Check in and Cancel. | Day-by-day navigation, a doctor filter, and status filters with counts. Each visit is laid out as in [Visit rows](#visit-rows). |
| Refunds | No interface. | Explained before sending (see [Refund dialog](#refund-dialog)). |
| Doctors & team (was "Clinic team") | A flat member list with Remove, and doctor search. | Four sections (see [Doctors & team sections](#doctors--team-sections)). |
| Forbidden pages | One generic message. | Role-specific explanation and way back (see [Role boundary checks](#role-boundary-checks)). |

### Overview sections

- **Needs attention:**
  - in-clinic visits not checked in 15+ minutes after the start (or ended without check-in);
  - payment holds, with the time they are released;
  - any doctor double-booked.
- **Today's appointments.**
- **Doctors working today:** time range, visits, checked in, done.
- **Invitations waiting** for a doctor's answer.
- **Clinic team** counts.

### Visit rows

- **Time:** start and end.
- **Who:** doctor, booking reference and mode.
- **Status:** appointment status.
- **Check-in state:** "Not arrived yet", "Not arrived (late)", "Checked in 9:47 pm", "Ended without check-in", or "Online: no check-in".
- **Payment state:** "Paid ₹500.00", "Awaiting payment", "Partly refunded", "Refunded" or "No fee".
- **Actions:**
  - **Check in:** only while the server allows it, from one hour before the start until the end.
  - **Refund:** while money was taken and not all returned.
  - **Cancel:** only before the start; the confirmation explains the automatic full refund.

### Refund dialog

- What the patient paid, and the payment's current state.
- Why: Goodwill gesture, Charged twice or Other, each explained.
- How much: everything not yet refunded, or a specific amount.
- That refunds can't be undone, and are recorded with your name and the reason.
- After sending: where the money goes, and that the status updates when the payment provider confirms.
- One idempotency key per dialog, so a repeated click cannot refund twice.

### Doctors & team sections

- **Clinic details**, read-only, noting that HealthBridge maintains them.
- **Doctors practising here:** verified status, speciality, "In clinic here", and booked visits in the next 7 days.
- **Membership:**
  - a four-step explainer: Invite → Doctor accepts → Active → Ended;
  - doctors and administrators listed separately, each with a status and what it means;
  - specific actions, each with a confirmation saying what happens: Withdraw invitation, End membership, Remove administrator.
- **Invite a doctor:** shows who already practises here. The success message says the doctor accepts from their Professional profile.

## Confusing states found and fixed

1. **Check in after the visit ended** (clinic board and the doctor's Today): the button was offered, then failed with "Check-in is possible … from one hour before the start". It is now shown only while the server accepts it, and the visit reads "Ended without check-in".
2. **Cancel after the start** (clinic board and the doctor's appointment list): the button was offered, but the server refuses once a visit has started. It is now hidden after the start.
3. **Cramped rows:** in the overview's narrower column, action buttons squeezed status and payment into a vertical stack, and times wrapped ("10:23 / pm"). Actions now sit under the details, and the time column no longer wraps.
4. **Long dialogs on small screens:** a dialog taller than the screen could not scroll. It now scrolls.

## Remaining issues

- **Patient names and visit reasons:** the clinic cannot see them, by design of the existing authorization. The desk works with booking references.
- **Doctors' hours:** a doctor's published hours (and online consultation modes) are not readable by clinic administrators (the slots API refuses them). "Doctors practising here" therefore shows booked visits at this clinic rather than hours.
- **Membership and verification on one row:** the membership list (account names) and the practising-doctors list (professional profiles) cannot be joined reliably, because the member list has no doctor ID. Verification is therefore shown on the practising list only.
- **Refund history:** the clinic sees payment state only, not the individual refunds. An already partly refunded payment shows "Partly refunded", and the server enforces the remaining amount.
- **Clinic details** can only be edited by platform administrators.
- **Patient's list:** the patient's own appointment list still offers Cancel on a visit that has started but not ended; the patient's appointment page already hides it.
- No automated accessibility audit (axe) was run.
