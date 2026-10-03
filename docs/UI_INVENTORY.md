# UI inventory and design-system plan (UI refinement phase)

This is an internal audit of the web app, taken before the design-system work. It
records what exists, what is inconsistent, and what this phase changes. The phase adds
no new features and changes no API behaviour.

## 1. Routes and pages

| Area | Routes | Page component(s) | Roles |
|---|---|---|---|
| Public | `/`, `/login`, `/register`, `/forgot-password`, `/reset-password`, `/verify-email` | HomePage, LoginPage, RegisterPage, AccountRecoveryPages | everyone |
| Home | `/app` | RoleHome: the same card grid for every role | all |
| Account | `/app/account` | AccountPage | all (patients reach it only from Profile) |
| Patient | `/app/doctors`, `/app/appointments`, `/app/appointments/book`, `/app/appointments/:id/pay`, `/app/appointments/:id/consultation`, `/app/records`, `/app/timeline`, `/app/privacy`, `/app/follow-ups`, `/app/profile`, `/app/notifications` | MyDoctorsPage, AppointmentsPage (patient view), BookAppointmentPage, PaymentPage, ConsultationPage, RecordsPage (includes prescriptions), TimelinePage, PrivacyPage, FollowUpsPage, ProfilePage, InboxPage | patient / guardian |
| Doctor | `/app/appointments` (schedule + availability tabs), `/app/patients`, `/app/medical-records`, `/app/medical-records/:patientId`, `/app/appointments/:id/brief`, `/app/appointments/:id/consultation`, `/app/follow-ups`, `/app/doctor-profile` | AppointmentsPage (doctor view), DoctorPatientsPage, DoctorRecordsPage, AiAssist (brief), ConsultationPage, FollowUpsPage, DoctorProfilePage | doctor |
| Clinic admin | `/app/clinic`, `/app/appointments` | ClinicPage, AppointmentsPage (clinic board) | clinic admin |
| Platform admin | `/app/admin/verification`, `/app/admin/clinics`, `/app/admin/users`, `/app/admin/audit`, `/app/admin/operations` | VerificationQueuePage, ClinicsAdminPage, UsersAdminPage, AuditLogPage, OperationsPage | platform admin |
| Support | `/app/admin/users`, `/app/appointments` | UsersAdminPage (read-only), AppointmentsPage → **dead end** ("not available yet") | support |

## 2. Inconsistencies found

**Page headers.** There are 32 `<h1>` elements in 7 different class combinations (margins,
sizes). Every page hand-writes its own title, intro text and action layout. Nothing tells
the user where they are within the product (no area or eyebrow label).

**Form controls.** `TextField` and `SelectField` exist, but 13 pages hand-roll `<input>`,
5 hand-roll `<textarea>` and 3 hand-roll `<select>`. Labels, heights, focus and error
styling vary across them. There is no shared textarea, checkbox, radio or file field.

**Buttons.** The primary, secondary, ghost and danger variants exist, but:

- there is no icon support, no loading state and no small size;
- seven raw `<button>`s are used for tabs and link-like actions.

**Feedback.**

- `Alert` has no `warning` tone. **This is a bug:** the Operations page and the video
  room pass `tone="warning"`, which renders unstyled. Success and info look identical.
- There is no reusable "permission denied" or "consent required" state; each page
  phrases these differently.
- Loading is shown three ways (skeletons, spinner, plain text).

**Empty states.** `EmptyState` is used on 10 pages, but it has no icon or action
(variants), and 7 places show plain grey text instead ("No doctors in this care team
yet.", "No prescriptions yet.", "No patients yet.", "No extracted values yet." …). These
leave the user without a next step.

**Status badges.** `StatusBadge` maps 26 statuses, but these are unmapped and fall back to
grey:

- documents: scanning, quarantined, available, retired;
- consent: revoked;
- notes and prescriptions: signed, superseded;
- follow-ups: scheduled, awaiting_response, responded, needs_attention, urgent, closed;
- consultations: live;
- dead letters: open, retried;
- care relationships: declined.

Several pages build their own tone maps (follow-ups, the audit outcome, lab flags). Badges
are colour-only: there is no icon or text cue for colour-blind users beyond the label.

**Navigation.**

- **One structure for every role:** a plain text list with no icons. Labels are
  technical ("Dashboard", "Patients", "Medical Records").
- **Mobile:** a sideways-scrolling strip, with no menu or indication of more items.
- **Patients:** "Prescriptions" is hidden at the bottom of Health Records, and "Sign-in &
  security" is not in the navigation.
- **Doctors:** the home page is a generic card grid, not today's work.
- **Support:** an "Appointments" item leads to a dead end.

**Dialogs.** Signing a clinical note and signing a prescription use `window.confirm`: an
unstyled native dialog with a generic, unbranded appearance that doesn't use the app's
focus handling.

**Identity.** Doctors are shown as plain text names. There is no avatar or initials, and
no consistent "verified doctor" indicator.

**First use.** Role home pages don't say what to do first: there are no profile, care-team
or booking hints for a new patient, and no "today" view for a doctor.

## 3. What this phase changes

1. **Design tokens:** info, warning, success and danger soft tones; a radius and shadow
   scale; focus ring; reduced motion.
2. **UI kit** (`components/ui`):
   - page and section headers;
   - text helpers;
   - Button (icons, loading, sizes, `destructive`/`subtle` aliases);
   - TextField, SelectField, TextAreaField, CheckboxField, RadioGroup, FileField;
   - Alert (four tones with icons);
   - Notice (permission denied, consent required);
   - EmptyState (icon, action, compact variant);
   - LoadingState;
   - StatusBadge (healthcare vocabulary with icons);
   - Avatar / PersonIdentity (initials, verified mark);
   - ConfirmDialog (focus trap, Escape, focus return).
3. **Healthcare status vocabulary:** every domain status maps to one of Confirmed,
   Pending, Requires attention, Completed, Cancelled, Verified, Needs review, Expired (plus
   In progress), each with a consistent tone and icon. The specific label is kept
   ("Pending payment", "Urgent").
4. **Navigation per role**, with plain labels and icons, a responsive sidebar, and an
   accessible mobile menu:

   | Role | Navigation |
   |---|---|
   | Patient | Home, My Doctors, Appointments, Health Records, Prescriptions, Timeline, Follow-ups, Privacy & Access, Profile, Sign-in & security |
   | Doctor | Today, Schedule, My Patients, Patient Records, Follow-ups, Professional profile, Sign-in & security |
   | Clinic admin | Clinic overview, Clinic schedule, Clinic team, Sign-in & security |
   | Platform admin | Overview, Doctor verification, Clinics, Users, Audit log, Operations, Sign-in & security |
   | Support | Overview, User lookup, Sign-in & security (the dead-end item is removed) |

5. **Role home pages** that answer "what next", using existing data and endpoints only:
   - **patient:** first-use steps (profile, add a doctor, book) and upcoming visits;
   - **doctor:** today's appointments and follow-ups needing attention;
   - **clinic admin:** today's clinic schedule;
   - **platform admin:** pending verifications and job health;
   - **support:** lookup.
6. **Pages:** consistent headers, empty states with a next action, shared form controls
   and badges. `window.confirm` is replaced with ConfirmDialog.
7. **Patient Prescriptions route:** reuses the existing `PatientPrescriptions` component
   and API. It surfaces existing data; it is not a new feature.
