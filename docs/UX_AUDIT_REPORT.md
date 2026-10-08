# HealthBridge UX audit report

The question: can a completely new user understand and complete each existing workflow without help? No features were added and nothing was redesigned. Business logic is unchanged, except one read-only addition: the public clinic address on in-clinic appointments.

## How it was tested

Each role was driven through its workflow in Chromium as a brand-new user, mostly at phone width (390×844). Every step recorded a screenshot, the visible text and the actions on offer, and each screen was judged against the eight questions in the brief. All data is synthetic.

Local database fixtures were used only for steps that depend on time:

- moving a booking to start in five minutes (waiting room, consultation, check-in);
- opening a follow-up check-in today;
- expiring a consent or a payment hold;
- ending a session on the server.

After the fixes, every finding was re-checked in the rebuilt stack, and the axe/overflow audit was re-run over 176 role, page and viewport combinations, with no violations remaining. All 13 gates of `npm run check` pass.

## Critical issues (fixed)

| Issue | Fix |
|---|---|
| The demo video room showed developer text to patients and doctors ("The mock provider issues a real, short-lived join token… npm start -- --video") | Plain wording: the call is simulated in this demo, and everything else works as in a real consultation |
| "Your connection looks unstable" appeared next to "We couldn't find this" when opening someone else's appointment or a missing one, a regression from the previous pass | The notice now appears only for real connection or server failures |
| A failed upload left a second copy of the document marked "Uploading…" for up to 15 minutes, and the home page counted it as "being checked" | The entry explains that an interrupted upload should be uploaded again and is cleared automatically. It no longer counts as being checked. (The automatic expiry was already in place.) |

## High-priority issues (fixed)

| Issue | Fix |
|---|---|
| After registering, the sign-in page said "If this email can be used for a new account, you can now sign in…", so new users couldn't tell whether it had worked | "Nearly there: sign in below with the email and password you just chose…", with the email prefilled. The wording is identical whether or not the email already existed, so it still reveals nothing. |
| A doctor had no way to know where to start; registration speaks only to patients | Registration says "Are you a doctor?" and explains the route |
| A doctor waiting for verification saw only patient onboarding on their home page | Their home page shows the registration status (waiting, being reviewed, not approved, suspended) with a link to their professional profile |
| Guardian: a child's doctors page was titled "Their Doctors" with patient wording, and couldn't be reached from My Doctors | My Doctors has the same "Showing records of" switch as Records, Privacy and Follow-ups. The page names the child: "Aarav's doctors" and "You manage Aarav's care…". |
| A request that was only pending showed "Already in your care team" in search results | "Request sent: waiting for them to accept", or "They invited you" |
| When a saved session couldn't be restored, the user landed on sign-in with no explanation | "You were signed out to keep your health information safe. Sign in again to carry on where you left off." The user returns to the page they were on. |
| In-clinic appointments named the clinic but gave no address, so patients didn't know where to go | The appointment shows the clinic address and a tap-to-call phone number. Booking shows the city. This is public clinic data only. |
| If the AI service was down, the doctor saw "HealthBridge is temporarily unavailable" | "The AI assistant isn't available right now. The records themselves are unaffected…" |
| Screen readers announced the availability day buttons as "Mon day" and "Tue sday" (regression) | Each is announced as one word ("Monday"), with "Mon" still shown |

## Medium-priority issues (fixed)

- **Dates and times:**
  - Date-only events, such as a follow-up's due day, showed a wrong clock time on the home page ("5:30 pm"). They now show the date only.
  - Admin and clinic screens used numeric dates ("6/10/2026, 10:50:21 am"). They now read "6 Oct 2026, 10:50 am", with seconds kept only in the audit log.
- **Status that didn't match the state:**
  - After check-in, the home page still said "Check in at reception when you arrive". The hint now follows the status: checked in, or consultation in progress.
  - "Appointment booked." reappeared on every later visit. It now shows once.
  - Onboarding step 2 still said "to do" after the request was sent. It now says "waiting" and offers "View request".
- **Payment page:**
  - The test panel said "webhook". That's gone.
  - The back link was a text arrow. It's now the standard back link.
  - Patients weren't told what happens if they don't pay. The page now explains that an unpaid booking is simply released.
- **The patient's access history** repeated the same line many times a minute. Repeats are grouped ("… · 7 times, 11:25–11:26 am").
- **Doctor registration form:** an empty "Year of registration" said "Enter 1950 or more." It now says "Enter the year you registered, for example 2014."
- **Greeting:** "Welcome, Dr" used the title as a first name. The greeting now skips titles.
- **Doctor verification:** history read "8/10/2026: pending". It now reads "Submitted Thu, 8 Oct, 11:29 am · waiting for review". The admin also gets a confirmation after verifying, rejecting or suspending.
- **Timeline:** "Export (JSON)" is now "Download a copy", and the "Online managed" badge is now "Managed online".
- **After ending a consultation**, the doctor had no next step. "Back to today" is now offered.

## Cosmetic issues (fixed)

- "Sex" offered both "Prefer not to say" and "Unspecified". The second now reads "Other or not listed".
- The mobile-number example looked like a pre-filled value. It's now a hint.
- "Specialization" on the doctor form is now "Speciality", matching everywhere else.
- Prescription routes are capitalised ("Oral", "Topical").
- "1 administrators" on the clinic overview now uses the correct plural.
- On a first refund, the button now says "Refund ₹500.00" rather than "Refund the rest".
- The audit log shows "Platform administrator" rather than "PLATFORM_ADMIN", along with plain categories, outcomes ("Refused") and resource names.
- Week-grid appointments are always 24px touch targets without overlapping, because the grid scales to the week's shortest visit.

## Workflows that are now complete

- **Patient:**
  1. Registration.
  2. Profile.
  3. Find a doctor and read their profile.
  4. Request care, and the doctor accepts.
  5. Book a clinic visit or an online consultation.
  6. Payment: failure, retry and success.
  7. Upload a report: wrong type, interrupted transfer and success.
  8. Share records.
  9. Review the appointment.
  10. Waiting room, which is automatic and explained.
  11. Video consultation (demo room).
  12. Summary and prescription.
  13. Timeline.
  14. Follow-up check-in.
  15. Notifications.
  16. Revoke consent: the doctor's next request is refused.
- **Doctor:**
  1. Registration.
  2. Professional profile.
  3. Submit for verification.
  4. Verified.
  5. First-day empty state.
  6. Availability.
  7. Schedule.
  8. Accept a patient request.
  9. Patient records.
  10. AI brief.
  11. Consultation.
  12. SOAP note: draft, then sign.
  13. Prescription: draft, then sign.
  14. Outcome.
  15. Follow-up.
- **Clinic admin:** overview, then clinic details, doctors and membership, then the schedule and appointments, then check-in by booking reference, then refund.
- **Platform admin:** verification (queue, review, verify and reject), clinics, users, audit and operations, with the forbidden clinical-records page.
- **Guardian:** add a dependent, then the dependent's doctors (request and accept), booking for the dependent, their records, privacy and follow-ups.
- **Negative cases:**
  - no doctor;
  - no appointment;
  - payment failure;
  - expired payment;
  - a cancelled appointment;
  - no consent;
  - revoked consent;
  - expired consent;
  - an unauthorized patient or doctor;
  - a slot taken meanwhile;
  - an invalid upload;
  - a failed upload;
  - AI with insufficient evidence ("Insufficient information. Please consult the doctor.");
  - failed AI processing;
  - a failed notification (it reaches the operations console with Retry);
  - an expired session.

## Remaining issues that should not be fixed by adding features

- **Live video** was checked only in the demo room. The LiveKit room is covered by the opt-in video e2e journey, which wasn't run in this pass.
- **The doctor-registration route** goes through a patient account (Profile → "Set up a doctor profile"). It is now signposted, but a separate doctor sign-up would be a new feature.
- **The operations console** shows technical job errors such as "ScannerError…". Only operators see it, and the raw cause is what they need.
- **The audit log** keeps raw action codes (`admin.users_list`). They are the searchable identifiers auditors filter by.
- **Unfinished uploads** stay listed (with an explanation) until the automatic clean-up runs. Removing them sooner would change the document lifecycle.
- **Failed notifications** aren't shown to the patient, because notices never contain medical details and are retried. Operators see them.
- **Screen readers and zoom** (NVDA, JAWS, VoiceOver, and 200% zoom) still need a manual check.
