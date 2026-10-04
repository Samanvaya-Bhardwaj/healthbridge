# Patient experience review

A first-time walk-through of HealthBridge as a new patient, in a real browser on the local
stack: register, create the profile, find a doctor, wait for them to accept, book, pay,
prepare for the visit, upload a report, then the privacy, timeline, follow-up and
prescription pages. Desktop (1366 px) and mobile (390 px). Synthetic data only.

This phase changed the patient interface only. The API, the database, permissions and
the AI service are unchanged, and no new business features were added. One existing API
capability, sharing records for a single appointment, is now offered on the appointment
page; before, no screen offered it.

## Where a newcomer had to stop and think, and what changed

| # | Moment | Problem | Fix |
|---|---|---|---|
| 1 | After "Create profile" | The form silently turned into "Save changes", with no confirmation and no next step. | A "Your health profile is ready" message with a **Find a doctor** button. |
| 2 | Home during setup | Four empty cards and "Nothing needs your attention" sat under the setup steps, diluting the one next action. | Until the patient has a doctor or a booking, home shows only the three numbered steps, each with one button. |
| 3 | Choosing a doctor | Search results showed only name and speciality, so nothing answered "why trust them" or "when can I see them". | Each result has a "Profile and availability" section: registration verified by HealthBridge (council and number), qualifications, experience, languages, clinic and bio, plus each consultation type with its fee and next free time. |
| 4 | After sending a request | Unclear what happens next. | "Request pending" badge with "Waiting for Dr X to accept. You will get a notification; you can book once they accept." There is also a "How a care team works" explainer (Request, Pending, Accepted, Paused, Ended). |
| 5 | Booking | Mode buttons, day tabs and slot grid on one screen, with no fee or rules until the end. | Five numbered steps (type, date, time, reason, confirm and pay) with a running summary. Mode cards show the fee and clinic. Times are grouped Morning, Afternoon and Evening. The cancellation and refund rule, the payment hold and how to join are stated before paying. |
| 6 | Booking (bug) | The date row overflowed its card under the summary panel. | Fixed (`min-w-0` on the step's fieldset). |
| 7 | After payment | "Payment received" was a dead end. | A "What happens next" card and a **Go to the appointment** button. |
| 8 | "Where do I join?" | Waiting room, payment, sharing and summary were spread over the list, the consultation room and Privacy & Access. | One appointment page (`/app/appointments/:id`). It shows what happens next, visit details and payment, a "Before your consultation" checklist (share records for this appointment, upload reports), the waiting room and video, then the summary, prescription and follow-up. |
| 9 | In-person visit request | The "Book an in-clinic visit" button left out the patient, so it led to an error. | The link now carries the patient. |
| 10 | Health Records | "Checking file", "Waiting for the safety check" and "Extracted values" read like internals, and the AI values section appeared even with AI reading off. | States are now Uploading, Processing (safety check), Available with "Secure: passed the safety check", and Rejected with what to do. There is a confirmation after upload. AI-suggested values appear only when AI reading is on. |
| 11 | Privacy & Access | The sharing form was checkbox lists with internal labels ("View documents", "Document types (none = all)"). | Four numbered choices (who, what, why, how long) with plain descriptions and a one-sentence summary before "Give access". "How sharing works" explains who, what, why, how long, revoking and checking. Active access reads as a sentence with days left. Access history is grouped by day, with Everything, Doctors and Refused filters. |
| 12 | Timeline | Badges did not explain themselves. | A dated, vertical timeline with a "What the labels mean" key: Patient reported, Doctor reported, Verified. Each kind has its own icon. |
| 13 | Prescriptions | Every version looked the same. | A signed prescription is visually authoritative ("Signed · valid", with a primary download button). Drafts are dashed and marked "not valid until signed". Replaced versions fold under the current one, and the correction reason is shown. |
| 14 | Follow-ups | A plain form, without saying why it was asked or when to worry. | It says why ("Dr X asked how you are…"). Three questions: a large Better / About the same / Worse choice, warning signs with an immediate "call 112 or 108" prompt, and an optional note. Each state is explained in one sentence. Urgent check-ins show a Call 112 button. Rules and safety behaviour are unchanged, and no AI decision is involved. |
| 15 | Errors | Generic server wording ("The requested resource was not found.", "Missing or invalid CSRF token") and a "404" eyebrow could reach patients. | All API errors pass through one plain-language translation. Status codes are never shown. |
| 16 | Access history | Health Records (patient) and Patient Records (doctor) loaded every document's AI values on page load, even unopened. The patient's access history then listed views that never happened (for example, "Dr X viewed the values suggested from…"). | Those values now load only when the panel is opened, so the history reflects real views. |
| 17 | Clinical notes | Notes used SOAP headings (Subjective, Objective…). | Patients see "What you told the doctor", "What the doctor found", "The doctor's assessment", "Plan and advice". |

## Patient home

Ordered by what matters now:

1. The next appointment, as the dominant card with one action: pay, waiting room, join, or view.
2. "Needs your attention": urgent check-ins (Call 112), check-ins to answer, unpaid bookings and doctor invitations.
3. Later appointments.
4. Recent health activity.
5. My doctors.
6. Health records.
7. Prescriptions.

With no upcoming appointment, the top card offers "Book with Dr X", or "Find a doctor" when the patient has no doctor yet.

## Navigation (patient)

| Group | Items |
|---|---|
| My care | Home, My Doctors, Appointments, Follow-ups |
| My health | Health Records, Prescriptions, Timeline |
| Account | Notifications, Privacy & Access, Profile, Sign-in & security |

## Remaining issues (not changed in this phase)

- "AI-suggested values need a doctor's review" is visible only inside each document's panel. Showing it in the document list would need one request per document, or a list field from the API.
- Opening the AI values panel writes a "You viewed…" entry in the patient's own access history, even for the patient's own views. That is backend audit behaviour and was left unchanged.
- The patient's own profile form is long (personal, contact, emergency contact) and could be split into steps.
- Payment, registration and sign-in pages kept their existing layout; only the payment confirmation changed.
- No automated accessibility audit (axe) was run. Keyboard flows were covered by unit tests: the booking day picker, dialogs and radio cards.
