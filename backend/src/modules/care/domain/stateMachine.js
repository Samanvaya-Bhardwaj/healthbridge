import { ConflictError, ForbiddenError } from '../../../core/http/errors.js';

/**
 * Care relationship lifecycle ("My Doctors").
 *
 *   patient requests ──► PENDING ──doctor accepts──► ACTIVE ◄──resume── PAUSED
 *   doctor invites   ──► INVITED ─patient accepts──► ACTIVE ───pause──► PAUSED
 *   PENDING/INVITED  ──counterparty declines / initiator withdraws──► ENDED
 *   ACTIVE/PAUSED    ──either party ends──► ENDED
 *
 * Only ACTIVE confers treating-doctor access; PAUSED immediately suspends it.
 * `party` is which side acts: 'patient' (the patient or a managing guardian) or 'doctor'.
 */
const RULES = {
  accept: { pending: 'doctor', invited: 'patient', to: 'active' },
  decline: { pending: 'doctor', invited: 'patient', to: 'ended', endReason: () => 'declined' },
  withdraw: { pending: 'patient', invited: 'doctor', to: 'ended', endReason: () => 'withdrawn' },
  pause: { active: 'patient', to: 'paused' },
  resume: { paused: 'patient', to: 'active' },
  end: {
    active: 'either',
    paused: 'either',
    to: 'ended',
    endReason: (party) => (party === 'patient' ? 'patient_ended' : 'doctor_ended'),
  },
};

export const CARE_ACTIONS = Object.freeze(Object.keys(RULES));

/** @returns {{ to: string, endReason?: string }} */
export function careTransition(status, action, party) {
  const rule = RULES[action];
  const allowedParty = rule?.[status];
  if (!allowedParty) {
    throw new ConflictError(
      `Cannot ${action} a relationship that is ${status}.`,
      'invalid_care_transition',
    );
  }
  if (allowedParty !== 'either' && allowedParty !== party) {
    throw new ForbiddenError(
      `Only the ${allowedParty} can ${action} this relationship.`,
      'wrong_party',
    );
  }
  return { to: rule.to, ...(rule.endReason ? { endReason: rule.endReason(party) } : {}) };
}
