import { isUuid } from '../../../core/db/ids.js';

/**
 * Refresh token format: `<sessionId>.<secret>`.
 * The session ID locates the row; only SHA-256(secret) is stored. The secret is 256-bit
 * random and rotates on every refresh.
 */
const SECRET = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url

export const composeRefreshToken = (sessionId, secret) => `${sessionId}.${secret}`;

/** @returns {{ sessionId: string, secret: string } | null} */
export function parseRefreshToken(token) {
  if (typeof token !== 'string' || token.length > 100) return null;
  const [sessionId, secret, ...rest] = token.split('.');
  if (rest.length || !isUuid(sessionId) || !SECRET.test(secret ?? '')) return null;
  return { sessionId, secret };
}
