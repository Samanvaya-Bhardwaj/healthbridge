# UX quality review

A quality pass over the existing application: accessibility, responsive layout, loading, empty, error, permission and consent states, long content, slow networks and form validation. No new features were added.

## How it was checked

- **Automated audit.** A real Chromium browser signed in as each role and opened every main page at four viewports: 390×844, 768×1024, 1440×900 and 1920×1080.
  - **Roles:** public, patient, guardian (the patient's dependent), doctor, clinic admin, platform admin and support.
  - **Coverage:** 176 page/viewport combinations.
  - **Checks:** axe-core rules for WCAG 2.0, 2.1 and 2.2 A/AA; horizontal overflow; JavaScript errors.
- **Long content.** Synthetic long values were set temporarily, the audit was run again, and the original values were restored. The values were:
  - a 64-character doctor name;
  - an 86-character clinic name;
  - a 95-character document title with no spaces;
  - 60 extra notifications with long titles and bodies.

  Signed prescription items can't be edited because a database trigger freezes them. Long drug names were therefore checked only through the existing wrapping styles.
- **Slow network.** Every API call was delayed by 2.5 s. The test double-clicked the main action in each flow, counted the requests actually sent, and took screenshots while they were pending. Flows covered: booking, payment checkout, simulated payment, upload, AI question and prescriptions.
- **Code review.**
  - Every mutation was checked for a pending guard.
  - Every query was checked for error handling.
  - Visible text was checked for technical wording.
- **Test suites.** All 13 gates of `npm run check` pass: unit, integration (220), frontend (79), build, end-to-end (8 passed, the video test skipped) and the backup drill.

## Accessibility fixes

| Issue | Fix |
|---|---|
| State colours on tinted backgrounds were below 4.5:1 (success badge 4.05:1) | Light tokens darkened: success `#236841`, warning `#82520a`, attention `#974522`, danger `#a63229`. Each now passes on its own 15% tint over a muted surface. |
| Week grid text used `opacity-80` (3.67:1) | Full-strength text |
| Week grid appointments were 18 px tall (target size) | Grid scale 1.2 px/min, with a minimum height of 24 px for links |
| Notification bell's `aria-label` didn't match its visible text | The visible text forms the accessible name: "Notifications 3 unread" |
| Unread dot was a `span` with `aria-label` | `role="img"` |
| Availability day buttons were named "Monday" but showed "Mon" | Visible "Mon" plus screen-reader "day" |
| Account and verification `<dl>` contained invalid children | Valid `dt`/`dd` structure |
| Scrollable tables and the week grid couldn't be reached by keyboard | They are focusable named regions |
| Route changes were silent for screen readers and the tab title never changed | `useRouteFocus` names the tab after the page heading and moves focus to it after navigation. Tabs and filters (query changes) leave focus alone. |

The dialog focus trap and focus return, field `aria-invalid`/`aria-describedby`, skip links and `role="alert"` errors were already in place and still pass.

## Responsive fixes

- **Responsive grids.** Grids declared only `lg:grid-cols-2`, so on phones they had one implicit column sized to their content, and a long name widened the page. 28 files now declare `grid-cols-1` (a `minmax(0, 1fr)` column) as the base.
- **Names.** People's names wrap instead of being cut off with an ellipsis.

After these fixes there is no horizontal overflow at any viewport, including with long content.

## Loading

- **Session restore.** A full page load used to show a lone spinner on an empty page. It now shows the HealthBridge mark and the text "Restoring your session…".
- **Payment.** The button reads "Opening secure payment…" with a spinner. "Simulate successful payment" shows a spinner.
- **AI question.** The button shows the AI-styled "Searching…" state.
- **Accept, withdraw and clinic invitation responses** show progress.

## Duplicate submissions

A disabled button only takes effect after React re-renders. Under the delayed network, a double-click on "Book appointment" sent two booking requests. The server's idempotency key stopped a second appointment being created, but the browser should send only one request.

- **The fix.** `useSafeMutation` drops any call while the same action is already in flight, and every mutation now uses it. The exception is "Mark read" on notifications, because several can safely run at once.
- **Result with a 2.5 s delay and double-clicks:** one request each for booking, checkout, simulated payment, upload and the AI question.
- **Buttons with no pending guard before:** accept or withdraw a patient, accept or decline a clinic invitation, stop managing a family member, and mark read.

## Empty and error states

- **`LoadError`.** A new component says what couldn't be loaded, gives the plain-language reason and offers "Try again". It is used for:
  - the doctor's schedule;
  - time off;
  - today at the clinic;
  - follow-ups on a patient record;
  - booking and payment details on an appointment;
  - the patient home.
- **Patient home.** If a load failed, the home page used to look like a brand-new account ("add your first doctor") to a patient who already has doctors. It now shows the error. The records and prescriptions rows say "Couldn't load just now" instead of "No documents yet".
- **Consultation room.** When polling fails, it shows "Your connection looks unstable…" and keeps retrying.
- **Missing error messages.** Clinic invitation responses, ending a guardianship and loading family members now show errors.

## Form validation

Field errors that came from the validator were shown as written, for example "Too small: expected string to have >=2 characters". A shared plain-language message map (`shared/src/validationMessages.js`) now applies to both browser forms and API field errors. Examples:

- "Use at least 2 characters."
- "This is required."
- "Enter an email address like name@example.com."
- "Choose one of the options."

Messages written for a specific field still take precedence.

## Permissions and consent

- **"Stop managing" a family member** used to end the guardianship on a single tap. It now asks for confirmation and explains what changes. Their record is kept.
- **Visible text** contains no technical consent terms, status codes or IDs.
- **Already in place:** the forbidden pages (role-aware, including "Platform administrators do not have access to clinical records.") and the consent-required notices.

## Remaining issues

- **Long notifications** wrap correctly but make the inbox long. Clamping them would hide content, so they were left as they are.
- **Not checked by automation:** screen-reader output in NVDA, JAWS and VoiceOver, and 200% zoom. Both need a manual pass.
- **Not run under the slow-network test:** joining a live video consultation. It needs two live parties. The join action uses the same in-flight guard.
- **Leftover synthetic data:** the slow-network test created one paid in-clinic booking and one uploaded document for the demo patient.
