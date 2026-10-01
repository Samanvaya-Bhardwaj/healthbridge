import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  PASSWORD,
  authHeader,
  auditFor,
  cookieHeaders,
  createHarness,
  createUser,
  login,
  register,
  uniqueEmail,
} from './harness.js';

let h;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

describe('audit trail', () => {
  it('records successful sensitive actions with request ID, actor, IP and user agent', async () => {
    const email = uniqueEmail('audited');
    await register(h.app, { email });
    const requestId = '0192b6f0a1b2c3d4e5f60718293a4c01';
    const res = await request(h.app)
      .post('/api/v1/auth/login')
      .set('X-Request-Id', requestId)
      .set('User-Agent', 'HealthBridgeTest/1.0')
      .send({ email, password: PASSWORD });
    expect(res.headers['x-request-id']).toBe(requestId);

    const [event] = await auditFor(h.knex, { request_id: requestId });
    expect(event).toMatchObject({
      category: 'authentication',
      action: 'auth.login',
      outcome: 'success',
      actor_type: 'user',
      actor_user_id: res.body.data.user.id,
      resource_type: 'session',
      user_agent: 'HealthBridgeTest/1.0',
    });
    expect(event.ip).toBeTruthy();
    expect(event.session_id).toBe(event.resource_id);
  });

  it('records failed logins without the attempted password', async () => {
    const requestId = '0192b6f0a1b2c3d4e5f60718293a4c02';
    await request(h.app)
      .post('/api/v1/auth/login')
      .set('X-Request-Id', requestId)
      .send({ email: uniqueEmail('nobody'), password: 'my secret attempt 123' });
    const [event] = await auditFor(h.knex, { request_id: requestId });
    expect(event).toMatchObject({
      action: 'auth.login',
      outcome: 'failure',
      actor_type: 'anonymous',
    });
    expect(JSON.stringify(event)).not.toContain('my secret attempt');
  });

  it('is append-only for the application role', async () => {
    await expect(
      h.knex('audit.audit_logs').update({ outcome: 'success' }).where({ outcome: 'denied' }),
    ).rejects.toThrow(/permission denied/);
    await expect(h.knex('audit.audit_logs').del().where({ outcome: 'denied' })).rejects.toThrow(
      /permission denied/,
    );
  });

  it('reading the audit log is itself audited, and the API exposes no secrets', async () => {
    const admin = await createUser(h, { label: 'auditor', roles: ['PLATFORM_ADMIN'] });
    const res = await request(h.app)
      .get('/api/v1/admin/audit-logs?limit=50')
      .set(authHeader(admin.session));
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(JSON.stringify(res.body)).not.toMatch(/argon2|hb_refresh|Bearer /);
    const [event] = await auditFor(h.knex, { actor_user_id: admin.id, action: 'audit.read' });
    expect(event.outcome).toBe('success');
  });

  it('paginates audit logs with an opaque cursor', async () => {
    const admin = await createUser(h, { label: 'pager', roles: ['PLATFORM_ADMIN'] });
    const first = await request(h.app)
      .get('/api/v1/admin/audit-logs?limit=2')
      .set(authHeader(admin.session));
    expect(first.body.data).toHaveLength(2);
    const next = await request(h.app)
      .get(`/api/v1/admin/audit-logs?limit=2&cursor=${first.body.meta.nextCursor}`)
      .set(authHeader(admin.session));
    expect(next.body.data[0].id).not.toBe(first.body.data[0].id);
    const bad = await request(h.app)
      .get('/api/v1/admin/audit-logs?cursor=%%%')
      .set(authHeader(admin.session));
    expect(bad.status).toBe(400);
  });
});

describe('secrets never leak', () => {
  it('passwords, hashes and tokens never appear in application logs', async () => {
    const user = await createUser(h, { label: 'logscan' });
    await request(h.app).post('/api/v1/auth/refresh').set(cookieHeaders(user.session)).send();
    await request(h.app).get('/api/v1/auth/me').set(authHeader(user.session));
    await login(h.app, { email: user.email, password: 'wrong attempt phrase' });

    const serialized = JSON.stringify(h.logs);
    expect(serialized).not.toContain(PASSWORD);
    expect(serialized).not.toContain('wrong attempt phrase');
    expect(serialized).not.toContain(user.session.accessToken);
    expect(serialized).not.toContain(user.session.refreshToken.split('.')[1]);
    expect(serialized).not.toContain(user.session.csrfToken);
    expect(serialized).not.toMatch(/\$argon2id\$/);
  });

  it('no account endpoint returns the password hash', async () => {
    const user = await createUser(h, { label: 'nohash' });
    for (const path of ['/api/v1/auth/me', '/api/v1/users/me', '/api/v1/auth/sessions']) {
      const res = await request(h.app).get(path).set(authHeader(user.session));
      expect(JSON.stringify(res.body)).not.toMatch(/argon2|password|refresh_token|csrf_token/i);
    }
  });

  it('raw refresh tokens are never stored, only their hashes', async () => {
    const user = await createUser(h, { label: 'hashonly' });
    const [sessionId, secret] = user.session.refreshToken.split('.');
    const row = await h.knex('sessions').where({ id: sessionId }).first();
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(JSON.stringify(row)).not.toContain(user.session.csrfToken);
    expect(row.refresh_token_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('rate limiting', () => {
  let limited;
  beforeAll(async () => {
    limited = await createHarness({
      rateLimits: {
        loginAccount: { points: 3, durationSeconds: 60 },
        register: { points: 2, durationSeconds: 60 },
      },
    });
  });
  afterAll(async () => {
    await limited.close();
  });

  it('limits login attempts per account with 429 and Retry-After', async () => {
    const email = uniqueEmail('ratelimit');
    const statuses = [];
    for (let i = 0; i < 4; i += 1) {
      statuses.push(
        (await login(limited.app, { email, password: 'wrong phrase entirely' })).status,
      );
    }
    expect(statuses).toEqual([401, 401, 401, 429]);
    const res = await login(limited.app, { email, password: 'wrong phrase entirely' });
    expect(res.status).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(res.body.code).toBe('rate_limited');
  });

  it('limits registrations per IP', async () => {
    const statuses = [];
    for (let i = 0; i < 3; i += 1)
      statuses.push((await register(limited.app, { email: uniqueEmail('rl') })).status);
    expect(statuses).toEqual([202, 202, 429]);
  });
});
