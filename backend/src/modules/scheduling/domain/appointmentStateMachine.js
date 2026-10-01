import { ConflictError, ForbiddenError } from '../../../core/http/errors.js';

/**
 * Appointment lifecycle (ADR-0019).
 *
 *   book ──fee 0──► CONFIRMED            book ──fee > 0──► PENDING_PAYMENT ──pay (M4)──► CONFIRMED
 *   PENDING_PAYMENT ──hold expires──► EXPIRED (system)
 *   PENDING_PAYMENT | CONFIRMED ──cancel──► CANCELLED
 *   CONFIRMED ──check_in (in clinic)──► CHECKED_IN
 *   CONFIRMED | CHECKED_IN | IN_CONSULTATION ──complete──► COMPLETED
 *   CONFIRMED ──no_show──► NO_SHOW
 *   (IN_CONSULTATION is entered by the consultation module, M9)
 *
 * Parties: 'patient' (patient or managing guardian), 'doctor', 'clinic' (clinic
 * administrator of the appointment's clinic). Time rules use the appointment window.
 */

const NO_SHOW_GRACE_MINUTES = 15;
const CHECK_IN_EARLY_MINUTES = 60;

const RULES = {
  cancel: {
    from: ['pending_payment', 'confirmed'],
    parties: ['patient', 'doctor', 'clinic'],
    to: 'cancelled',
    // Patients cannot cancel once the appointment has started (it is a no-show by then).
    when: (a, now, party) => party !== 'patient' || now < a.starts_at,
    whenMessage: 'This appointment has already started.',
  },
  reschedule: {
    from: ['pending_payment', 'confirmed'],
    parties: ['patient'],
    to: 'cancelled',
    when: (a, now) => now < a.starts_at,
    whenMessage: 'This appointment has already started.',
  },
  check_in: {
    from: ['confirmed'],
    parties: ['doctor', 'clinic'],
    to: 'checked_in',
    when: (a, now) =>
      a.mode === 'in_clinic' &&
      now >= new Date(a.starts_at.getTime() - CHECK_IN_EARLY_MINUTES * 60_000) &&
      now < a.ends_at,
    whenMessage: 'Check-in is possible for in-clinic visits from one hour before the start.',
  },
  complete: {
    from: ['confirmed', 'checked_in', 'in_consultation'],
    parties: ['doctor'],
    to: 'completed',
    when: (a, now) => now >= a.starts_at,
    whenMessage: 'An appointment can be completed only after it starts.',
  },
  no_show: {
    from: ['confirmed'],
    parties: ['doctor', 'clinic'],
    to: 'no_show',
    when: (a, now) => now >= new Date(a.starts_at.getTime() + NO_SHOW_GRACE_MINUTES * 60_000),
    whenMessage: `A no-show can be recorded ${NO_SHOW_GRACE_MINUTES} minutes after the start.`,
  },
};

export const APPOINTMENT_ACTIONS = Object.freeze(Object.keys(RULES));

/**
 * @param {{ status: string, starts_at: Date, ends_at: Date, mode: string, hold_expires_at?: Date|null }} appointment
 * @returns {string} the next status
 */
export function appointmentTransition(appointment, action, party, now = new Date()) {
  const rule = RULES[action];
  if (!rule) throw new ConflictError(`Unknown action ${action}.`, 'invalid_appointment_transition');
  if (!rule.parties.includes(party)) {
    throw new ForbiddenError(
      `The ${party} cannot ${action.replace('_', ' ')} this appointment.`,
      'wrong_party',
    );
  }
  const heldExpired =
    appointment.status === 'pending_payment' &&
    appointment.hold_expires_at &&
    appointment.hold_expires_at <= now;
  if (!rule.from.includes(appointment.status) || heldExpired) {
    throw new ConflictError(
      `Cannot ${action.replace('_', ' ')} an appointment that is ${heldExpired ? 'expired' : appointment.status.replace('_', ' ')}.`,
      'invalid_appointment_transition',
    );
  }
  if (!rule.when(appointment, now, party)) {
    throw new ConflictError(rule.whenMessage, 'appointment_time_rule');
  }
  return rule.to;
}

/** Initial status of a new booking. */
export const initialStatus = (feePaise) => (feePaise > 0 ? 'pending_payment' : 'confirmed');
