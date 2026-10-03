import { PRIVILEGED_ROLES } from '@healthbridge/shared';

/** Failed-login handling: temporary lock after repeated failures (ADR-0015). */
export const LOCKOUT = Object.freeze({ maxFailedAttempts: 5, lockMinutes: 15 });

/**
 * Window in which presenting the immediately-previous refresh token is treated as a
 * benign race (two tabs refreshing at once) instead of token theft.
 */
export const REFRESH_REUSE_GRACE_SECONDS = 10;

export const REVOKE_REASONS = Object.freeze({
  LOGOUT: 'logout',
  USER_REVOKED: 'user_revoked',
  ADMIN_REVOKED: 'admin_revoked',
  PASSWORD_CHANGED: 'password_changed',
  PASSWORD_RESET: 'password_reset',
  ACCOUNT_DISABLED: 'account_disabled',
  REFRESH_TOKEN_REUSE: 'refresh_token_reuse',
  EXPIRED: 'expired',
});

export const isPrivileged = (roles) => roles.some((role) => PRIVILEGED_ROLES.includes(role));

/**
 * Session lifetimes depend on the user's roles: clinical and administrative accounts get
 * shorter idle and absolute lifetimes than patients.
 * @param {string[]} roles
 * @param {{ standard: { idleSeconds: number, absoluteSeconds: number }, privileged: { idleSeconds: number, absoluteSeconds: number } }} lifetimes
 */
export function sessionLifetimeFor(roles, lifetimes) {
  return isPrivileged(roles) ? lifetimes.privileged : lifetimes.standard;
}

/** Next idle expiry, never beyond the absolute expiry. */
export function nextIdleExpiry(now, idleSeconds, absoluteExpiresAt) {
  const idle = new Date(now.getTime() + idleSeconds * 1000);
  return idle < absoluteExpiresAt ? idle : absoluteExpiresAt;
}

export function isSessionExpired(session, now) {
  return now >= session.idle_expires_at || now >= session.absolute_expires_at;
}
