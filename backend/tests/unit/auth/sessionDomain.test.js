import { describe, expect, it } from 'vitest';
import {
  composeRefreshToken,
  parseRefreshToken,
} from '../../../src/modules/identity/domain/refreshToken.js';
import {
  isSessionExpired,
  nextIdleExpiry,
  sessionLifetimeFor,
} from '../../../src/modules/identity/domain/sessionPolicy.js';
import { generateSecret } from '../../../src/core/auth/secrets.js';

const sessionId = '0192b6f0-0000-7000-8000-000000000002';

describe('refresh token format', () => {
  it('round-trips session id and secret', () => {
    const secret = generateSecret();
    expect(parseRefreshToken(composeRefreshToken(sessionId, secret))).toEqual({
      sessionId,
      secret,
    });
  });

  it.each([
    undefined,
    '',
    'garbage',
    `${sessionId}`,
    `not-a-uuid.${generateSecret()}`,
    `${sessionId}.short`,
    `${sessionId}.${generateSecret()}.extra`,
    'x'.repeat(500),
  ])('rejects malformed token %#', (token) => {
    expect(parseRefreshToken(token)).toBeNull();
  });
});

describe('session lifetimes', () => {
  const lifetimes = {
    standard: { idleSeconds: 3 * 86400, absoluteSeconds: 14 * 86400 },
    privileged: { idleSeconds: 12 * 3600, absoluteSeconds: 3 * 86400 },
  };

  it('gives clinical and administrative roles shorter sessions', () => {
    expect(sessionLifetimeFor(['PATIENT'], lifetimes)).toBe(lifetimes.standard);
    for (const role of ['DOCTOR', 'CLINIC_ADMIN', 'PLATFORM_ADMIN', 'SUPPORT']) {
      expect(sessionLifetimeFor(['PATIENT', role], lifetimes)).toBe(lifetimes.privileged);
    }
  });

  it('never extends idle expiry beyond the absolute expiry', () => {
    const now = new Date('2026-10-01T00:00:00Z');
    const absolute = new Date('2026-10-01T06:00:00Z');
    expect(nextIdleExpiry(now, 12 * 3600, absolute)).toEqual(absolute);
    expect(nextIdleExpiry(now, 3600, absolute)).toEqual(new Date('2026-10-01T01:00:00Z'));
  });

  it('treats a session as expired at idle or absolute expiry', () => {
    const now = new Date('2026-10-02T00:00:00Z');
    const later = new Date('2026-10-03T00:00:00Z');
    const earlier = new Date('2026-10-01T00:00:00Z');
    expect(isSessionExpired({ idle_expires_at: later, absolute_expires_at: later }, now)).toBe(
      false,
    );
    expect(isSessionExpired({ idle_expires_at: earlier, absolute_expires_at: later }, now)).toBe(
      true,
    );
    expect(isSessionExpired({ idle_expires_at: later, absolute_expires_at: now }, now)).toBe(true);
  });
});
