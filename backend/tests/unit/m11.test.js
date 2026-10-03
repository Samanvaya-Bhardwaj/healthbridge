import { describe, expect, it } from 'vitest';
import { basicAuthMatches } from '../../src/core/queue/bullBoard.js';
import { clientErrorSchema } from '../../src/modules/telemetry/routes.js';
import { loadConfig } from '../../src/config/index.js';
import { validEnv } from '../helpers.js';

const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

describe('Bull Board credentials', () => {
  const creds = { username: 'ops', password: 'a-long-board-password' };
  it('accepts only the exact username and password', () => {
    expect(basicAuthMatches(basic('ops', 'a-long-board-password'), creds)).toBe(true);
    expect(basicAuthMatches(basic('ops', 'a-long-board-passwor'), creds)).toBe(false);
    expect(basicAuthMatches(basic('admin', 'a-long-board-password'), creds)).toBe(false);
    // Passwords may contain colons; only the first one separates the username.
    expect(
      basicAuthMatches(basic('ops', 'pass:with:colons-123'), {
        ...creds,
        password: 'pass:with:colons-123',
      }),
    ).toBe(true);
    for (const header of [undefined, '', 'Bearer x', 'Basic', 'Basic !!!', basic('', '')]) {
      expect(basicAuthMatches(header, creds)).toBe(false);
    }
  });

  it('is disabled unless a password of 16+ characters is configured', () => {
    const base = validEnv;
    expect(() => loadConfig({ ...base, BULL_BOARD_PASSWORD: 'short' })).toThrow();
    const on = loadConfig({ ...base, BULL_BOARD_PASSWORD: 'x'.repeat(16) });
    expect(on.workers.bullBoard).toMatchObject({ enabled: true, port: 9466, username: 'ops' });
    const env = { ...base };
    delete env.BULL_BOARD_PASSWORD;
    expect(loadConfig(env).workers.bullBoard.enabled).toBe(false);
  });
});

describe('app URL for emailed links', () => {
  it('defaults to the first CORS origin and must be https outside development', () => {
    const dev = loadConfig({ ...validEnv, CORS_ORIGINS: 'http://localhost:8081' });
    expect(dev.http.publicAppUrl).toBe('http://localhost:8081');
    expect(() =>
      loadConfig({ ...validEnv, APP_ENV: 'staging', PUBLIC_APP_URL: 'http://staging.example' }),
    ).toThrow(/PUBLIC_APP_URL/);
    expect(() => loadConfig({ ...validEnv, PUBLIC_APP_URL: 'https://app.example/' })).toThrow();
  });
});

describe('client error reports', () => {
  it('keeps the error class and route template only', () => {
    const parsed = clientErrorSchema.parse({
      kind: 'render_error',
      name: 'RangeError',
      path: '/app/appointments/0192b6f0-a1b2-4c3d-8e5f-60718293a4c0/consultation',
    });
    expect(parsed).toEqual({
      kind: 'render_error',
      name: 'RangeError',
      path: '/app/appointments/:id/consultation',
    });
    expect(clientErrorSchema.parse({ kind: 'window_error', name: 'X', path: '/' }).name).toBe(
      'Other',
    );
    expect(
      clientErrorSchema.safeParse({ kind: 'window_error', name: 'Error', path: 'app' }).success,
    ).toBe(false);
  });
});
