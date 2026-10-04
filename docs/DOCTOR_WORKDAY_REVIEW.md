# Doctor experience review

A working day as Dr. Meera (demo doctor), in a real browser on the local stack:
1. Two online consultations booked by a patient; the first is due in five minutes, the
   patient is waiting and has shared records for that appointment.
2. Start it from Today, sign the note, write and sign a prescription, and record the
   outcome with a follow-up.
3. Then go through the week schedule, hours and time off, patients, the patient record,
   the AI brief, follow-ups and the professional profile.

Desktop (1440 px) and mobile (390 px). Synthetic data only.

This phase changed the doctor interface only. The API, schema, permissions, consent rules
and AI behaviour are unchanged. No new business capability was added. Every screen uses
data the doctor already receives.

## Unnecessary clicks and confusing states, and what changed

| # | Moment | Before | Now |
|---|---|---|---|
| 1 | Starting the day | "Today" listed times and statuses only. Whether the patient was waiting, had shared records, or had paid was not visible. | The next consultation is featured, and each visit shows its state at a glance (see [Today](#today-in-detail)). |
| 2 | Starting a consultation | Open consultation, then press Start: two steps. | **Start consultation** on Today starts it and opens the room. |
| 3 | During the consultation | The room had no patient context, and the reason for the visit sat behind the schedule list. | A side panel shows the patient (name, age), the reason (on request; reading it is audited), whether records are shared and until when, and open follow-ups. Records and AI brief open in a new tab so the video keeps running. |
| 4 | Where am I in the consultation? | Several cards, with no sense of order. | A progress line: Started → Note signed → Prescription (optional) → Outcome recorded. |
| 5 | Draft or signed? | The same look for both. | The note shows "Draft · not in the record until signed", then "Signed · locked". A saved prescription draft shows as a dashed slip, "Draft · not valid until signed", until signed. Then it reads "Signed · valid". |
| 6 | Corrections | "Version 2" with a small "Correction:" line. | "Corrects version 1: reason". Earlier versions are folded under the current one. |
| 7 | Schedule | A list of appointments, plus availability on a separate tab as a flat list. | A **Week** time grid (see [Schedule safety](#schedule-safety)). Mobile gets the same information as a day-by-day agenda. Cancelled entries in the list are folded per day. |
| 8 | Hours | One weekday per form submission, slot length typed as a number, no effective dates, and overlaps found only after saving. | Hours grouped by weekday, each showing type, clinic, slot length, fee, effective dates and how many appointments are booked in them. The form takes several days at once (one rule per day; the server checks each), a slot-length list, a fee, and start and optional end dates. A plain summary appears before saving. |
| 9 | My Patients | Requests and patients in one flat list. | Requests first, with a confirmation on Decline. Patients needing follow-up come next, then by next consultation. Each shows age, records shared or not, next visit, and the follow-up state. Actions: Review follow-up, Patient record, End relationship. Sent invitations and past patients are separated. |
| 10 | Patient record | The title was "Shared records", without the patient's name. Everything sat on one long page, with AI questions mixed in among the source records. | Titled with the patient's name, age, what is shared and until when, plus upcoming consultations with this patient (AI brief and Open). Tabs: **Overview** (verified lab values, follow-ups, previous prescriptions), **Documents**, **Timeline**, **Ask AI**. |
| 11 | AI brief | "AI-generated" was a small badge; Back went to the schedule. | A dashed AI frame: "AI-generated · not a clinical opinion", the citation notice and when it was prepared. Back goes to the appointment. Citation and grounding behaviour are unchanged. |
| 12 | Follow-ups | A filter dropdown with the schedule form always open, in date order. | Tabs with counts, selecting the first group that has items (see [Follow-ups](#follow-ups-in-detail)). Each tab explains what it holds. Today links open a specific check-in directly. The schedule form is behind one button. |
| 13 | Professional profile | Edit form only. | "How patients see you": the same profile card patients see, with consultation types, fees, next free times and weekly hours. Verification is shown as it is: unverified profiles say "Registration not verified yet". Clinic membership explains its role in in-clinic hours. |
| 14 | Profile (bug) | Saving replaced the qualifications with the first one only, silently dropping any others. | Additional qualifications are kept and listed. |
| 15 | Today (bug) | On narrower desktop widths, the action buttons squeezed patient names into letter-by-letter wrapping. | The actions sit on their own line under each visit. |

## Today in detail

The next consultation is featured. Each visit shows:
- time, patient name and age;
- mode and status;
- payment: "Paid", "Awaiting payment" or "No fee", derived from the appointment (a fee-bearing appointment is confirmed only after verified payment);
- records shared or not;
- for online visits whose waiting room is open, "In the waiting room" or "Not in the waiting room yet", refreshed every 15 seconds;
- one main action: Start consultation, Join video, Check in (in-clinic, from one hour before), or Open appointment / Summary;
- Review patient and AI brief, when records are shared.

Urgent check-ins appear as a banner above. Follow-ups to review and new requests sit alongside.

## Follow-ups in detail

The tabs are **Urgent**, **Needs attention**, **Answered**, **Waiting for patient** and **Closed**, each with a count.

## Schedule safety

- **Week grid:** published hours (Available), appointments (Booked), slots held while a patient pays (Blocked) and time off, using the existing data only. Booked appointments open from the grid.
- **Overlapping hours:** refused before saving, with the clashing hours named. This mirrors the server's own rule (same weekday, overlapping dates and times, any mode), which still has the final say.
- **Removing hours:** the confirmation says how many upcoming appointments fall in them and that they stay booked.
- **Adding time off:** booked appointments in the period are listed before saving, and a confirmation explains that time off does not cancel them.
- **Booked counts:** existing appointments (next 62 days, the longest range the API serves) appear next to each hour block.

## Remaining issues

- Payment state for the doctor is derived from the appointment state. The doctor schedule API doesn't return payment status, and fetching each appointment would audit a "reason viewed" entry per appointment.
- Whether a patient turned on AI reading isn't visible to the doctor. The AI brief link appears whenever records are shared, and the brief page explains when AI reading is off.
- Removing time off has no confirmation (it only reopens booking).
- The room's page header still names the doctor, not the patient. The patient is shown in the side panel.
- The week grid shows times in the doctor's browser time zone and assumes it matches the hours' time zone. The form saves hours in the browser's time zone.
- No automated accessibility audit (axe) was run.
