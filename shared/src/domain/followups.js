/** M10 follow-up and in-app notification enumerations, rules and schemas (ADR-0026). */

import { z } from 'zod';

/**
 *   scheduled ──due date reached──► awaiting_response ──patient responds──► responded
 *                                                     │                    needs_attention
 *                                                     │                    urgent
 *                                                     └─no response (7 d)─► needs_attention
 *   any open status ──doctor closes──► closed;  scheduled ──doctor cancels──► cancelled
 */
export const FOLLOW_UP_STATUSES = Object.freeze([
  'scheduled',
  'awaiting_response',
  'responded',
  'needs_attention',
  'urgent',
  'closed',
  'cancelled',
]);
export const OPEN_FOLLOW_UP_STATUSES = Object.freeze([
  'scheduled',
  'awaiting_response',
  'responded',
  'needs_attention',
  'urgent',
]);
export const FOLLOW_UP_OVERALL = Object.freeze(['better', 'same', 'worse']);

/**
 * Warning signs the patient can report. Any one of them escalates the follow-up to
 * `urgent` and shows fixed emergency guidance immediately. Deterministic rules decide
 * escalation — never AI.
 */
export const FOLLOW_UP_RED_FLAGS = Object.freeze({
  chest_pain: 'Chest pain or pressure',
  breathing_difficulty: 'Difficulty breathing',
  confusion: 'New confusion or drowsiness',
  fainting: 'Fainting or collapse',
  severe_bleeding: 'Heavy or uncontrolled bleeding',
  seizure: 'A fit or seizure',
  persistent_high_fever: 'High fever for more than 3 days',
  severe_allergic_reaction: 'Swelling of the face or throat, or a severe rash',
});

/** Reminders: when due, again after this many hours without a response (max 2). */
export const FOLLOW_UP_REMINDER_INTERVAL_HOURS = 48;
export const FOLLOW_UP_MAX_REMINDERS = 2;
/** With no response this many days after the due date, the doctor is alerted. */
export const FOLLOW_UP_NO_RESPONSE_DAYS = 7;

/**
 * Escalation rules (pure and deterministic).
 * @returns {{ level: 'none'|'attention'|'urgent', status: string, reasons: string[] }}
 */
export function evaluateFollowUpResponse({ overall, redFlags = [] }) {
  if (redFlags.length) {
    return { level: 'urgent', status: 'urgent', reasons: redFlags.map((f) => `red_flag:${f}`) };
  }
  if (overall === 'worse') {
    return { level: 'attention', status: 'needs_attention', reasons: ['reported_worse'] };
  }
  return { level: 'none', status: 'responded', reasons: [] };
}

const isPlainText = (v) =>
  [...v].every((ch) => {
    const code = ch.codePointAt(0);
    return code === 0x0a || code === 0x09 || (code >= 0x20 && code !== 0x7f);
  });

export const followUpResponseSchema = z
  .object({
    overall: z.enum(FOLLOW_UP_OVERALL),
    redFlags: z
      .array(z.enum(Object.keys(FOLLOW_UP_RED_FLAGS)))
      .max(Object.keys(FOLLOW_UP_RED_FLAGS).length)
      .refine((v) => new Set(v).size === v.length, 'Each warning sign only once.')
      .default([]),
    note: z.string().trim().max(1000).refine(isPlainText, 'Use plain text only.').default(''),
  })
  .strict();

export const createFollowUpSchema = z
  .object({
    dueOn: z.iso.date(),
    appointmentId: z.uuid().optional(),
  })
  .strict();

export const closeFollowUpSchema = z
  .object({ note: z.string().trim().max(500).refine(isPlainText).default('') })
  .strict();

// ── In-app notifications (inbox) ────────────────────────────────────

export const INBOX_PAGE_LIMIT = 50;
