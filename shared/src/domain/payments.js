/** M4 payment and notification enumerations and schemas shared by frontend and backend. */

import { z } from 'zod';

export const PAYMENT_PROVIDERS = Object.freeze(['fake', 'razorpay']);

/**
 * Payment lifecycle (ADR-0020). One `payments` row per provider order.
 *
 *   pending ──authorized──► authorized ──captured──► paid ──refund──► partially_refunded ──► refunded
 *   pending | authorized | failed ──captured──► paid
 *   pending | authorized ──failed──► failed  (the patient may retry on the same order)
 *   pending | authorized | failed ──hold expired / appointment cancelled──► cancelled
 *   cancelled ──captured (late, provider-confirmed)──► paid  → automatic full refund
 */
export const PAYMENT_STATUSES = Object.freeze([
  'pending',
  'authorized',
  'paid',
  'failed',
  'cancelled',
  'refunded',
  'partially_refunded',
]);
/** Statuses in which the payment can still become `paid` for its appointment. */
export const OPEN_PAYMENT_STATUSES = Object.freeze(['pending', 'authorized', 'failed']);

export const REFUND_STATUSES = Object.freeze(['pending', 'processing', 'processed', 'failed']);
export const REFUND_REASONS = Object.freeze([
  'appointment_cancelled',
  'rescheduled',
  'late_capture',
  'goodwill',
  'duplicate_payment',
  'other',
]);
/** Reasons a doctor or clinic may give for a manual refund. */
export const MANUAL_REFUND_REASONS = Object.freeze(['goodwill', 'duplicate_payment', 'other']);

/** A patient who cancels at least this long before the start gets a full refund. */
export const PATIENT_FULL_REFUND_HOURS = 24;

export const NOTIFICATION_TEMPLATES = Object.freeze([
  'appointment_booked',
  'payment_required',
  'payment_confirmed',
  'payment_failed',
  'appointment_cancelled',
  'appointment_rescheduled',
  'appointment_expired',
  'appointment_reminder',
  'payment_refunded',
  // M5: generic wording only (never document names or contents)
  'document_available',
  'document_rejected',
  // M9: generic wording only (never medicines, notes or diagnoses)
  'prescription_available',
  'in_person_visit_requested',
  'emergency_guidance',
  // M10: follow-ups (generic wording; never symptoms or the patient's note)
  'follow_up_due',
  'follow_up_attention',
  'follow_up_urgent',
]);

export const manualRefundSchema = z
  .object({
    amountPaise: z.number().int().positive().max(10_000_000).optional(),
    reasonCode: z.enum(MANUAL_REFUND_REASONS),
  })
  .strict();

export const simulatePaymentSchema = z.object({ outcome: z.enum(['success', 'failure']) }).strict();

/** Formats integer paise as rupees for display, e.g. 50000 → "₹500.00". */
export function formatPaise(paise, currency = 'INR') {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency }).format(paise / 100);
}
