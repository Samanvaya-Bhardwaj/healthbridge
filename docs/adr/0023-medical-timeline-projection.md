# ADR-0023: Medical timeline as a provenance-labelled projection

- **Status:** Accepted
- **Date:** 2026-10-03

## Context

Patients and doctors need one chronological view of the record: visits, documents and
verified results. The view must show where each entry came from, so that patient-reported,
doctor-verified and AI-derived information is never confused. It must respect the M5
consent scopes.

## Decision

- **`medical_events` is a projection, not a source of truth.** The `timeline` worker
  fills it from outbox events:
  - `appointment.*`;
  - `document.available`, `document.analyzed` and `document.retired`;
  - `lab_result.verified`.

  The projector **re-reads the source row** (it never trusts payloads) and upserts one
  event per source. Duplicates, replays and out-of-order delivery therefore converge.
  `rebuildPatient` re-projects everything, and a one-off backfill job covers data that
  predates M7.
- **Provenance on every event:** `patient_reported`, `guardian_reported`,
  `doctor_reported`, `doctor_verified`, `ai_extracted` or `system_recorded`, plus an
  actor label.
  - Fields that AI derived (a document's date or issuer) are listed explicitly.
  - Unverified AI proposals are **never** timeline events. Only doctor-verified lab values
    are.
- **Dates:** each event has a date precision (`day` for document and lab dates, otherwise
  `instant`). The timeline is ordered newest first, with keyset pagination on
  `(occurred_at, id)`.
- **Hidden events:** retired documents and expired payment holds are hidden, not deleted.
- **Scope:**
  - The API treats the timeline as part of the medical record (`medical_records:read`
    plus consent).
  - RLS then shows the patient side everything.
  - A doctor sees document and lab events only when their consent covers the document
    type, and appointment events only for their own appointments.
  - Only the `timeline` system purpose writes the projection.
- **Export:** `GET /patients/:id/timeline/export` returns versioned JSON
  (`healthbridge.timeline.v1`) with a provenance legend. It is limited to the patient side
  and audited (`timeline.exported`).

## Consequences

- The timeline may lag the sources by the outbox delay. Sources remain authoritative, and
  a rebuild repairs any drift.
- New record types (M9 notes and prescriptions) add a source and a projector function.
