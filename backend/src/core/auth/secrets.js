import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 256-bit URL-safe random secret (refresh tokens, CSRF tokens). */
export const generateSecret = (bytes = 32) => randomBytes(bytes).toString('base64url');

/**
 * SHA-256 hex digest. Appropriate for high-entropy random secrets (not passwords):
 * brute-forcing a 256-bit secret is infeasible, so a slow hash adds nothing.
 */
export const sha256Hex = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

/** Constant-time comparison of two equal-length hex digests. */
export function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
