import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { requireCsrf } from '../../../src/core/auth/csrf.js';
import { createAuthenticate } from '../../../src/core/auth/authenticate.js';
import { TokenError } from '../../../src/core/auth/tokens.js';
import { errorHandler } from '../../../src/core/http/errorHandler.js';
import { requestId } from '../../../src/core/http/requestId.js';
import { sanitizeMetadata } from '../../../src/modules/audit/sanitize.js';

const ORIGIN = 'http://localhost:5173';

function csrfApp() {
  const app = express();
  app.post('/refresh', requireCsrf({ allowedOrigins: [ORIGIN] }), (_req, res) =>
    res.status(204).end(),
  );
  app.use(errorHandler());
  return app;
}

describe('CSRF protection', () => {
  it('accepts allowed origin with matching header and cookie', async () => {
    const res = await request(csrfApp())
      .post('/refresh')
      .set('Origin', ORIGIN)
      .set('Cookie', 'hb_csrf=abc123')
      .set('X-CSRF-Token', 'abc123');
    expect(res.status).toBe(204);
  });

  it.each([
    ['missing origin', {}, 'csrf_origin_rejected'],
    ['foreign origin', { Origin: 'https://evil.example' }, 'csrf_origin_rejected'],
    ['missing header', { Origin: ORIGIN, Cookie: 'hb_csrf=abc123' }, 'csrf_token_invalid'],
    [
      'mismatch',
      { Origin: ORIGIN, Cookie: 'hb_csrf=abc123', 'X-CSRF-Token': 'zzz' },
      'csrf_token_invalid',
    ],
  ])('rejects %s', async (_name, headers, code) => {
    const res = await request(csrfApp()).post('/refresh').set(headers);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(code);
  });

  it('falls back to Referer when Origin is absent', async () => {
    const res = await request(csrfApp())
      .post('/refresh')
      .set('Referer', `${ORIGIN}/app`)
      .set('Cookie', 'hb_csrf=t')
      .set('X-CSRF-Token', 't');
    expect(res.status).toBe(204);
  });
});

describe('authenticate middleware', () => {
  const principal = { userId: 'u1', sessionId: 's1', roles: [], permissions: new Set() };
  const token = 'aaa.bbb.ccc';

  function authApp({ verify, resolve }) {
    const authenticate = createAuthenticate({
      tokenService: { verifyAccessToken: verify },
      resolvePrincipal: resolve,
    });
    const app = express();
    app.use(requestId());
    app.get('/protected', authenticate(), (req, res) => res.json({ userId: req.principal.userId }));
    app.use(errorHandler());
    return app;
  }

  it('rejects requests without credentials (401 + WWW-Authenticate)', async () => {
    const res = await request(
      authApp({ verify: async () => ({}), resolve: async () => principal }),
    ).get('/protected');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('unauthenticated');
    expect(res.headers['www-authenticate']).toContain('Bearer');
  });

  it('rejects malformed authorization headers', async () => {
    const app = authApp({ verify: async () => ({}), resolve: async () => principal });
    const res = await request(app).get('/protected').set('Authorization', 'Basic dXNlcjpwYXNz');
    expect(res.body.code).toBe('token_invalid');
  });

  it('distinguishes expired tokens so clients can refresh', async () => {
    const app = authApp({
      verify: async () => {
        throw new TokenError('token_expired');
      },
      resolve: async () => principal,
    });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('token_expired');
  });

  it('rejects valid tokens whose session is no longer valid', async () => {
    const app = authApp({
      verify: async () => ({ userId: 'u1', sessionId: 's1' }),
      resolve: async () => null,
    });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.body.code).toBe('session_invalid');
  });

  it('attaches the principal for valid sessions', async () => {
    const app = authApp({
      verify: async () => ({ userId: 'u1', sessionId: 's1' }),
      resolve: async () => principal,
    });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.body).toEqual({ userId: 'u1' });
  });
});

describe('audit metadata sanitiser', () => {
  it('redacts secret-looking keys at any depth and bounds sizes', () => {
    const result = sanitizeMetadata({
      password: 'hunter2hunter2',
      nested: { refreshToken: 'abc', Authorization: 'Bearer x', ok: 'value', apiKey: 'k' },
      list: Array.from({ length: 50 }, (_, i) => i),
      long: 'x'.repeat(1000),
    });
    expect(JSON.stringify(result)).not.toMatch(/hunter2|Bearer x|"abc"/);
    expect(result.nested.ok).toBe('value');
    expect(result.list).toHaveLength(20);
    expect(result.long.length).toBeLessThan(210);
  });
});
