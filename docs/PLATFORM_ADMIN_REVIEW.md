# Platform administrator experience review

A working session as the demo platform administrator, in a real browser on the local stack:
- **Verification:** a new synthetic doctor applies; take the application, read it and reject it with a reason. Open (and back out of) the suspension of a verified doctor.
- **Clinics:** create a clinic, deactivate it, view a clinic's members.
- **Users:** disable a synthetic test account and reinstate it.
- **Audit:** open it from the overview's shortcuts (administrator actions; refused access).
- **Operations:** open a dead-letter retry and back out.
- **Boundary:** try a clinical page.

Desktop (1440 px) and mobile (390 px). Synthetic data only.

This phase changed the platform administrator interface only. The API, schema, permissions and role boundaries are unchanged, and no new capability was added. Three existing API capabilities now have screens:
- suspending a verified doctor;
- activating or deactivating a clinic;
- the full application detail for a verification case.

## Role boundary checks

- **No clinical endpoints:** the session made 63 API calls, none to a clinical endpoint. That covers consultations, prescriptions, documents, timeline, lab results, AI questions, briefs, follow-ups, consents, the access log and patient profiles.
- **Stated on every administration page:** "**Platform administrators do not have access to clinical records.** Administration covers accounts, doctor verification, clinics, the audit trail and background jobs. Medical records, notes, prescriptions, lab results and AI output never appear here."
- **Clinical pages explain the refusal:** opening one shows "You don't have access to this page" with "Platform administrators do not have access to clinical records." and what administration covers instead.
- **Audit entries:** expanded entries state that they hold identifiers and reason codes only, never clinical content.

## What changed

| Area | Before | Now |
|---|---|---|
| Overview | Two counts and a grid of links. | The boundary note and the background-job health banner, then the sections in [Overview](#overview). |
| Doctor verification | One list (pending and in-review only). Approve or reject with one click. No profile details, and no suspension. | Tabs with counts (Waiting, In review, Verified, Rejected, Suspended), each explained, opening on the work waiting. Each application shows its details and actions (see [Verification](#verification)). |
| Clinics | A name and city form, a list, and an administrator search with one-click appoint. | Details and confirmations as listed in [Clinics](#clinics). |
| Users | Disable, reinstate, sign out everywhere and role changes in one click, each with no confirmation. | Confirmations and filter links as listed in [Users](#users). |
| Audit log | Filters for category, outcome, action, actor, patient, request and dates; metadata as raw JSON. | Additions listed in [Audit log](#audit-log). |
| Operations | Raw counts with BullMQ state names, and a one-click Retry. | Plain states, an overall banner and a confirmed retry (see [Operations](#operations)). |

### Overview

- **Waiting for you:**
  - doctor applications to review, with how many are in review or waiting;
  - background jobs that gave up;
  - clinics, with how many are inactive.
- **Checks and lookups:** shortcuts that open with filters already applied:
  - find an account;
  - disabled accounts;
  - refused access (last 7 days);
  - failed sign-ins (last 24 hours);
  - administrator actions.

Account lists and the audit trail are not loaded on the overview, because reading them is itself audited.

### Verification

Each application shows:
- the doctor's identity;
- registration number, council and year;
- submitted time;
- current status;
- the decision reason and internal notes, where decided;
- the full professional profile on demand: speciality, qualifications, experience, languages and about. This read is audited.

Actions:
- **Verify:** needs a ticked "I checked registration … with … and the details match".
- **Reject:** needs a reason and takes optional internal notes.
- **Suspend** (verified doctors): needs a reason and a ticked acknowledgement that new bookings stop at once. It explains that booked appointments are not cancelled automatically.

### Clinics

- **Create:** the full clinic details the backend accepts (address, PIN code, phone, email, registration number), with field errors shown.
- **Filter:** All, Active or Inactive.
- **Per clinic:**
  - **Members:** role and status of each.
  - **Appoint administrator:** search, with a confirmation that clinic administrators never see medical records. Disabled accounts can't be chosen.
  - **Deactivate / Reactivate:** the confirmation states the effect (no new administrators or doctor invitations, the clinic is hidden on doctors' profiles, existing appointments are not cancelled).

### Users

- **Status:** what Active and Disabled mean for the person.
- **Disable:** needs a reason, as the backend requires. The confirmation says they are signed out everywhere and their data is not deleted.
- **Reinstate**, **sign out everywhere**, and **grant or remove a role** each confirm and explain.
- **Filters** can come from links (for example `?status=disabled`).
- **Phones:** the list keeps the account visible without sideways scrolling.

### Audit log

- **New filters:** **Resource** (account, session, doctor verification, clinic, consent, appointment, payment and so on), suggested common action names, and quick ranges (Today, Last 7 days, Last 30 days).
- **Clearer labels:** "User (who acted)", and a patient ID filter explained as "shows who accessed a patient's record".
- **Active filters** show as removable chips.
- **Metadata** is shown as readable key–value pairs.
- **Links:** filters can come from links.

### Operations

- **Overall banner:** Healthy, Needs attention or Job queue unreachable.
- **Legend:** Healthy, Pending, Processing, Scheduled or retrying, Failed, Dead letter.
- **Queues:** plain names (for example "Document safety checks and reading") with a health badge each.
- **Outbox:** waiting to relay, relayed, failed to relay.
- **Failed jobs:** Needs action, Retried and Resolved tabs, with first and last failure times and the failure reason.
- **Retry:** a confirmation explains that jobs are safe to repeat and that the cause should be fixed first.

## Confusing states found and fixed

1. **Review started, application still collapsed:** after "Start review", the application stayed folded because the card kept its "closed" state from the Waiting tab, costing an extra click. Applications in review now open by default.
2. **Hidden action on phones:** the Users table pushed the status and the View button off-screen. The name now opens the account, and status and roles sit under the name on small screens.
3. **Generic refusal:** the refusal page said administrators "never receive access to patients' medical records" without the required wording. It now states "Platform administrators do not have access to clinical records."

## Remaining issues

- **Raw user IDs in the audit log:** the actor appears as a shortened user ID. Showing names would mean extra account reads, each of them audited.
- **No last-administrator warning in advance:** the UI can't tell beforehand whether a role removal or disable affects the last platform administrator. The server refuses it, and the reason is shown.
- **No clinic editing:** clinic details can only be set at creation. The API has no edit endpoint, so none was added.
- **No reason for clinic deactivation:** the backend doesn't take one, so the UI doesn't ask.
- **No resolve action for dead letters:** "Resolved" dead letters are listed, but there is no resolve action, because the API has none.
- **No accessibility audit:** no automated accessibility audit (axe) was run.
