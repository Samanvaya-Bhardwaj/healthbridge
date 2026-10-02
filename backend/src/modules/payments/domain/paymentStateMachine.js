import { PATIENT_FULL_REFUND_HOURS } from '@healthbridge/shared';

/**
 * Payment lifecycle (ADR-0020). Transitions are driven only by verified provider events
 * (authorized / captured / failed / refund_processed) and by the system closing a payment
 * whose appointment can no longer be paid for (cancel).
 *
 * `paymentTransition` returns:
 *   { next }               the transition applies
 *   { next: null, reason } a stale or redundant event: recorded, but no state change
 *
 * Events never move a payment backwards from a terminal state. The single exception is a
 * provider-confirmed capture on a `cancelled` payment: money really moved, so the payment
 * becomes `paid` and the caller must refund it in full (late capture).
 */

const TRANSITIONS = {
  authorized: { pending: 'authorized', failed: 'authorized' },
  captured: {
    pending: 'paid',
    authorized: 'paid',
    failed: 'paid',
    cancelled: 'paid', // late capture → automatic refund
  },
  failed: { pending: 'failed', authorized: 'failed', failed: 'failed' },
  cancel: { pending: 'cancelled', authorized: 'cancelled', failed: 'cancelled' },
};

export const PAYMENT_EVENT_KINDS = Object.freeze(Object.keys(TRANSITIONS));

/**
 * @param {string} status current payment status
 * @param {'authorized'|'captured'|'failed'|'cancel'} kind
 */
export function paymentTransition(status, kind) {
  const table = TRANSITIONS[kind];
  if (!table) throw new Error(`unknown payment event kind ${kind}`);
  const next = table[status];
  if (next) return { next, lateCapture: kind === 'captured' && status === 'cancelled' };
  return { next: null, reason: `stale_${kind}` };
}

/** Status after a processed refund of `refundedPaise` in total. */
export function statusAfterRefund(amountPaise, refundedPaise) {
  if (refundedPaise <= 0) return 'paid';
  return refundedPaise >= amountPaise ? 'refunded' : 'partially_refunded';
}

/** Statuses from which money can be refunded. */
export const REFUNDABLE_STATUSES = Object.freeze(['paid', 'partially_refunded']);

/**
 * Automatic refund for a cancelled appointment.
 * - Cancelled by the doctor, the clinic or the system, or replaced by a reschedule: full.
 * - Cancelled by the patient at least PATIENT_FULL_REFUND_HOURS before the start: full.
 * - Cancelled by the patient later than that: none.
 * @returns {{ amountPaise: number, reason: 'appointment_cancelled'|'rescheduled' }}
 */
export function cancellationRefund({
  refundablePaise,
  cancelledByParty,
  cancelReason,
  startsAt,
  cancelledAt,
}) {
  const reason = cancelReason === 'rescheduled' ? 'rescheduled' : 'appointment_cancelled';
  if (refundablePaise <= 0) return { amountPaise: 0, reason };
  if (cancelReason === 'rescheduled' || cancelledByParty !== 'patient') {
    return { amountPaise: refundablePaise, reason };
  }
  const noticeMs = new Date(startsAt).getTime() - new Date(cancelledAt).getTime();
  return {
    amountPaise: noticeMs >= PATIENT_FULL_REFUND_HOURS * 3_600_000 ? refundablePaise : 0,
    reason,
  };
}
