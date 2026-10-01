import { ConflictError } from '../../../core/http/errors.js';

/**
 * Doctor credential-verification state machine (ADR-0018).
 *
 *   unverified ─submit→ pending ─start_review→ under_review ─decide→ verified | rejected
 *   rejected  ─submit→ pending          (resubmission after correcting details)
 *   verified  ─suspend→ suspended ─submit→ pending   (reinstatement requires re-review)
 *
 * A profile existing never implies verification; only an administrator decision moves a
 * doctor to `verified`, and only `verified` doctors can be treating doctors.
 */
const TRANSITIONS = {
  submit: { from: ['unverified', 'rejected', 'suspended'], to: 'pending' },
  start_review: { from: ['pending'], to: 'under_review' },
  verify: { from: ['under_review'], to: 'verified' },
  reject: { from: ['under_review'], to: 'rejected' },
  suspend: { from: ['verified'], to: 'suspended' },
};

export function nextVerificationStatus(current, action) {
  const rule = TRANSITIONS[action];
  if (!rule || !rule.from.includes(current)) {
    throw new ConflictError(
      `Cannot ${action.replace('_', ' ')} a doctor whose verification is ${current.replace('_', ' ')}.`,
      'invalid_verification_transition',
    );
  }
  return rule.to;
}

/** Registration details cannot change while they are being reviewed or once verified. */
export const REGISTRATION_LOCKED_STATUSES = new Set(['pending', 'under_review', 'verified']);
