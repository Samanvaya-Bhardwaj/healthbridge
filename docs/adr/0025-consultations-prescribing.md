# ADR-0025: Consultations, clinical notes and prescribing

- **Status:** Accepted
- **Date:** 2026-10-03
- **Implements:** ADR-0007 (video adapter), ADR-0009 (immutable clinical records)

## Context

A consultation produces medico-legal records:

- the doctor's notes;
- a prescription;
- the decision of how care continues.

These records must be:

- written only by the consulting doctor;
- impossible to alter silently;
- visible to the patient;
- shareable with other doctors only with consent.

The platform must never make a clinical decision itself.

## Decision

### Lifecycle

| Step | What happens |
|---|---|
| Waiting room | For online appointments, opens **15 minutes** before the start. The patient side sends a heartbeat (`consultation_presence`). The doctor sees whether the patient is waiting. Status polling returns no clinical content. |
| Start | Doctor only, with `consultations:conduct`. Allowed from 10 minutes before the start until 60 minutes after the end. In-clinic visits must be checked in first. The appointment moves to `in_consultation` (`start_consultation`). A `consultations` row is created; online consultations get a random video room. |
| Video | `VideoProvider` adapter: `mock` (default) or `livekit`. The backend issues short-lived (≤ 10 min), per-participant join tokens with opaque identities, after authorisation. It never relays media. |
| Notes | SOAP note, envelope-encrypted (see below). One draft, then **signed**. Signed notes are never edited. A **correction** creates a new signed version (`supersedes_id`, reason required) and marks the previous one `superseded`. |
| Prescription | One chain per consultation: draft → **signed** → superseded by a signed correction. Drafts are possible only while the consultation is live; corrections remain possible later. |
| Outcome | Recorded **once**, by the consulting doctor, then immutable. A and B need a signed note. The appointment is completed through `finish_consultation`; the generic "complete" action no longer applies to a live consultation. Unsigned prescription drafts are cancelled. |

The three outcomes:

- **A. `online_managed`.** Optional follow-up date; M10 schedules follow-ups from it.
- **B. `physical_visit_required`.** The patient is notified and offered in-clinic booking with the same doctor.
- **C. `emergency_escalation`.** No prerequisites. It needs an explicit confirmation and is audited as `consultation.emergency_escalated` with `flagged: true`. The patient immediately sees **fixed** emergency guidance (112 / 108 / nearest emergency department) and gets an urgent notice. The system never escalates by itself.

### Integrity

**Database triggers (backstop):**

- `consultations_guard`: identity is immutable, and an ended consultation is frozen.
- `clinical_notes_immutable`: no deletes. Signed content is frozen; the only change allowed is signed → superseded.
- `prescriptions_immutable`: no deletes. After signing, content, hash and seal are frozen. Allowed: signed → superseded, and setting the PDF fields once.
- `prescription_items_frozen`: items change only while the prescription is a draft.

**Privileges:** `DELETE` and `TRUNCATE` are revoked from `hb_app` on all M9 tables, and `UPDATE` on items.

**Prescription signature:**

- At signing, a canonical serialisation of the content (reference, version, patient, doctor, appointment, time, items, advice) is hashed with SHA-256 (`content_sha256`).
- The hash is sealed with HMAC-SHA256 under a key derived (HKDF) from the clinical key (`integrity_seal`, `seal_key_id`).
- The PDF renderer recomputes both from the database. It **refuses to render** if they no longer match.

**PDF:**

- Rendered **once per version** by the `documents` worker on `prescription.signed`.
- Uses a dependency-free, deterministic writer: identical input gives identical bytes, so retries are safe.
- Stored at `prescriptions/<patient>/<prescription>-v<n>.pdf` with its SHA-256.
- Served only through 60-second, audited presigned URLs.
- Outside production the PDF is marked *demonstration only / not valid for dispensing*.

### Encryption at rest (clinical notes)

- **Algorithm:** AES-256-GCM envelope encryption. Each note gets a fresh data key, wrapped by the key-encryption key named by `key_id`.
- **Binding:** both seals bind the associated data `clinical_note:<id>:<patient>`, so a ciphertext copied onto another row fails to decrypt.
- **Keys:** `CLINICAL_DATA_KEY` is required in staging and production. Development derives a stable key from `INTERNAL_SERVICE_SECRET` when it is unset.
- **Rotation:** previous keys stay readable through `CLINICAL_DATA_PREVIOUS_KEYS`.

### Prescribing rules (configurable safety net, not a compliance claim)

- Narcotic and psychotropic substances are blocked in **online** consultations. The default list is modelled on the Telemedicine Practice Guidelines (2020) prohibited list.
- Duplicate items are blocked.
- Before real use, a qualified person must review and maintain the list.

### Access

| Who | Notes | Prescriptions | Consultation and outcome |
|---|---|---|---|
| Consulting doctor (author) | all versions, including draft | all versions, including draft | yes |
| Patient side (self or guardian) | signed and superseded | signed and superseded | yes |
| Another treating doctor | **no** | signed, **only** with an active `medical_documents` consent covering the `prescription` type | timeline only, by consent |
| Clinic desk, platform admin, support | no | no | no |

Enforcement:

- **Application:** AccessPolicy. Gate 1 (permission) is evaluated before any lookup.
- **Database:** RLS. `SELECT … FOR UPDATE` applies the update policy, so only authors can lock their own records.
- **Audit:** reads and changes are audited, and the patient's access log describes them. Correction reasons and note content are never written to the audit log.
- **Notifications:** generic only, without medicines or note content: `prescription_available`, `in_person_visit_requested`, `emergency_guidance`.
- **Timeline:** shows the outcome and the prescription (reference, version, medicine names), labelled `doctor_reported`. Note content is never shown.

## Consequences

- Doctors cannot fix a typo in place: every correction is visible and versioned. This is intended.
- The waiting room uses polling every 5 seconds for status and 20 seconds for the heartbeat, not WebSockets. Real-time push is a Phase 2 item.
- The mock video provider issues real signed tokens but carries no media. A LiveKit deployment needs the LiveKit client in the frontend, which is a later integration.
- The PDF uses a standard font and plain layout, with no letterhead images. An electronically signed HealthBridge PDF is not a substitute for regulatory e-prescription requirements, which need legal review before real use.
