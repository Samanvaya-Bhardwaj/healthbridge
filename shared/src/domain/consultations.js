/** M9 consultation, clinical-note and prescription enumerations and schemas (ADR-0025). */

import { z } from 'zod';

// ── Consultations ───────────────────────────────────────────────────

/** live → ended. Created when the doctor starts the consultation. */
export const CONSULTATION_STATUSES = Object.freeze(['live', 'ended']);
/**
 * The doctor's decision at the end of a consultation (never made by the system):
 *   online_managed            A — managed online: notes (and any prescription) issued
 *   physical_visit_required   B — an in-person examination is needed
 *   emergency_escalation      C — the patient is directed to emergency care now
 */
export const CONSULTATION_OUTCOMES = Object.freeze([
  'online_managed',
  'physical_visit_required',
  'emergency_escalation',
]);
/** A waiting patient is "present" while their waiting-room heartbeat is this recent. */
export const WAITING_ROOM_PRESENCE_SECONDS = 45;
/** The waiting room opens this long before the start. */
export const WAITING_ROOM_OPENS_MINUTES = 15;
/** Static guidance shown for outcome C. It is fixed text, never generated. */
export const EMERGENCY_GUIDANCE = Object.freeze({
  title: 'Seek emergency care now',
  lines: Object.freeze([
    'Your doctor has advised that you need emergency care.',
    'Call 112 (India emergency number) or 108 for an ambulance, or go to the nearest emergency department immediately.',
    'Do not wait for an online consultation or a reply in the app.',
  ]),
});

const text = (max) => z.string().trim().max(max);
const isPlainText = (v) =>
  [...v].every((ch) => {
    const code = ch.codePointAt(0);
    return code === 0x0a || code === 0x09 || (code >= 0x20 && code !== 0x7f);
  });
const clinicalText = (max) => text(max).refine(isPlainText, 'Use plain text only.');

/** SOAP note. At least one section must be filled in. */
export const soapNoteSchema = z
  .object({
    subjective: clinicalText(4000).default(''),
    objective: clinicalText(4000).default(''),
    assessment: clinicalText(4000).default(''),
    plan: clinicalText(4000).default(''),
  })
  .strict()
  .refine((n) => Object.values(n).some((v) => v.length > 0), {
    message: 'Write at least one section of the note.',
  });

export const correctionReasonSchema = clinicalText(500).min(5, 'Explain the correction.');

export const noteCorrectionSchema = z
  .object({ note: soapNoteSchema, reason: correctionReasonSchema })
  .strict();

// ── Prescriptions ───────────────────────────────────────────────────

/** draft → signed → superseded (by a correction); draft → cancelled. */
export const PRESCRIPTION_STATUSES = Object.freeze(['draft', 'signed', 'superseded', 'cancelled']);
export const MEDICATION_ROUTES = Object.freeze([
  'oral',
  'topical',
  'inhalation',
  'nasal',
  'ophthalmic',
  'otic',
  'sublingual',
  'rectal',
  'vaginal',
  'transdermal',
  'other',
]);
export const MAX_PRESCRIPTION_ITEMS = 20;

export const prescriptionItemSchema = z
  .object({
    drugName: clinicalText(120).min(2, 'Enter the medicine name.'),
    strength: clinicalText(60).default(''),
    form: clinicalText(40).default(''),
    dose: clinicalText(60).min(1, 'Enter the dose.'),
    frequency: clinicalText(60).min(1, 'Enter how often.'),
    route: z.enum(MEDICATION_ROUTES).default('oral'),
    duration: clinicalText(60).min(1, 'Enter for how long.'),
    instructions: clinicalText(300).default(''),
  })
  .strict();

export const prescriptionDraftSchema = z
  .object({
    items: z.array(prescriptionItemSchema).min(1).max(MAX_PRESCRIPTION_ITEMS),
    advice: clinicalText(2000).default(''),
  })
  .strict();

export const prescriptionCorrectionSchema = z
  .object({
    items: z.array(prescriptionItemSchema).min(1).max(MAX_PRESCRIPTION_ITEMS),
    advice: clinicalText(2000).default(''),
    reason: correctionReasonSchema,
  })
  .strict();

// ── Outcome ─────────────────────────────────────────────────────────

const isoDate = z.iso.date();

export const consultationOutcomeSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('online_managed'),
      /** Suggested follow-up date (the follow-up workflow is scheduled from it). */
      followUpOn: isoDate.optional(),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('physical_visit_required'),
      /** Shown to the patient with the request to book an in-clinic visit. */
      visitNote: clinicalText(500).default(''),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('emergency_escalation'),
      /** The doctor must confirm explicitly. */
      confirm: z.literal(true),
    })
    .strict(),
]);
