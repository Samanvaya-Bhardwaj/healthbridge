import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@healthbridge/shared';
import { isCommonPassword } from './commonPasswords.js';

/**
 * Server-side password policy (NIST SP 800-63B style): length-based, no composition
 * rules, rejects common and context-specific passwords. Shared Zod schemas enforce
 * length on both client and server; this adds the checks that must stay server-side.
 *
 * @param {string} password
 * @param {{ email?: string, fullName?: string }} [context]
 * @returns {string | null} a user-facing reason, or null when acceptable
 */
export function checkPasswordPolicy(password, { email, fullName } = {}) {
  const length = [...password.normalize('NFKC')].length; // count code points, not UTF-16 units
  if (length < PASSWORD_MIN_LENGTH) return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (length > PASSWORD_MAX_LENGTH) return `Use at most ${PASSWORD_MAX_LENGTH} characters.`;

  const lower = password.toLowerCase();
  if (new Set(lower).size <= 2) return 'Choose a less repetitive password.';
  if (isCommonPassword(password)) return 'This password is too common. Choose a different one.';

  const localPart = email?.split('@')[0]?.toLowerCase();
  if (localPart && localPart.length >= 4 && lower.includes(localPart)) {
    return 'Your password must not contain your email address.';
  }
  const nameParts = (fullName ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter((part) => part.length >= 4);
  if (nameParts.some((part) => lower.includes(part))) {
    return 'Your password must not contain your name.';
  }
  return null;
}
