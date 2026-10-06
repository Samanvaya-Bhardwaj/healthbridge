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
  parseSetCookies,
  register,
  sessionFrom,
  uniqueEmail,
} from './harness.js';

let h;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

const refresh = (session, opts) =>
  request(h.app).post('/api/v1/auth/refresh').set(cookieHeaders(session, opts)).send();

describe('registration', () => {
  it('registers a new patient (202) without returning credentials', async () => {
    const email = uniqueEmail('register');
    const res = await register(h.app, { email, fullName: 'Asha Verma' });
    expect(res.status).toBe(202);
    expect(res.body.data.status).toBe('received');
    expect(JSON.stringify(res.body)).not.toMatch(/argon2|password/i);

    const user = await h.knex('users').where({ email }).first();
    expect(user.password_hash).toMatch(/^\$argon2id\$/);
    expect(user.password_hash).not.toContain(PASSWORD);
    expect(user.terms_version).toBeTruthy();
    const roles = await h.container.repositories.roles.rolesOf(user.id);
    expect(roles).toEqual(['PATIENT']);
  });

  it('duplicate registration returns an identical response and notifies the owner instead', async () => {
    const email = uniqueEmail('dup');
    const first = await register(h.app, { email });
    const second = await register(h.app, {
      email: email.toUpperCase(),
      password: 'another synthetic phrase 9',
    });
    expect(second.status).toBe(first.status);
    expect(second.body).toEqual(first.body);
    expect(await h.knex('users').where({ email }).count({ n: '*' })).toEqual([{ n: '1' }]);

    await new Promise((resolve) => setImmediate(resolve));
    expect(h.mailer.sent.map((m) => m.to)).toContain(email); // normalised to lowercase
    const [event] = await auditFor(h.knex, { action: 'auth.register', reason: 'email_in_use' });
    expect(event.outcome).toBe('failure');
  });

  it('rejects weak and common passwords with a field error', async () => {
    const res = await register(h.app, { email: uniqueEmail('weak'), password: 'Password-1234' });
    expect(res.status).toBe(400);
    expect(res.body.errors).toEqual([
      { path: 'body.password', message: expect.stringMatching(/common/) },
    ]);
  });

  it('requires accepting the terms and rejects unknown fields', async () => {
    const res = await request(h.app)
      .post('/api/v1/auth/register')
      .send({
        email: uniqueEmail('terms'),
        password: PASSWORD,
        fullName: 'X',
        acceptTerms: false,
        role: 'PLATFORM_ADMIN',
      });
    expect(res.status).toBe(400);
    const paths = res.body.errors.map((e) => e.path);
    expect(paths).toEqual(expect.arrayContaining(['body.acceptTerms']));
    // The unknown field (role) is rejected, in plain language rather than validator wording.
    expect(res.body.errors).toEqual(
      expect.arrayContaining([
        { path: 'body', message: 'Something unexpected was sent. Reload the page and try again.' },
      ]),
    );
  });
});

describe('login', () => {
  it('logs in, sets hardened cookies, and returns a short-lived access token', async () => {
    const email = uniqueEmail('login');
    await register(h.app, { email });
    const res = await login(h.app, { email });

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data).toMatchObject({
      tokenType: 'Bearer',
      expiresIn: 600,
      user: { email, roles: ['PATIENT'] },
    });
    expect(JSON.stringify(res.body)).not.toMatch(/password|argon2|refresh/i);

    const cookies = parseSetCookies(res);
    expect(cookies.hb_refresh.attributes).toEqual(
      expect.arrayContaining(['httponly', 'samesite=strict', 'path=/api/v1/auth']),
    );
    expect(cookies.hb_csrf.attributes).toEqual(
      expect.arrayContaining(['samesite=strict', 'path=/']),
    );
    expect(cookies.hb_csrf.attributes).not.toContain('httponly');

    const me = await request(h.app)
      .get('/api/v1/auth/me')
      .set(authHeader(sessionFrom(res)));
    expect(me.status).toBe(200);
    expect(me.body.data).toMatchObject({ email, roles: ['PATIENT'] });
    expect(me.body.data.permissions).toContain('medical_records:read');
  });

  it('rejects wrong passwords and unknown accounts identically (no enumeration)', async () => {
    const email = uniqueEmail('enum');
    await register(h.app, { email });
    const wrongPassword = await login(h.app, { email, password: 'definitely wrong phrase' });
    const unknown = await login(h.app, {
      email: uniqueEmail('ghost'),
      password: 'definitely wrong phrase',
    });

    for (const res of [wrongPassword, unknown]) {
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('invalid_credentials');
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    const strip = ({ requestId: _r, ...rest }) => rest;
    expect(strip(wrongPassword.body)).toEqual(strip(unknown.body));
  });

  it('locks the account after repeated failures, even for the correct password', async () => {
    const email = uniqueEmail('lockout');
    await register(h.app, { email });
    for (let i = 0; i < 5; i += 1)
      await login(h.app, { email, password: `wrong phrase number ${i}` });

    const res = await login(h.app, { email });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('invalid_credentials');
    const user = await h.knex('users').where({ email }).first();
    expect(user.locked_until.getTime()).toBeGreaterThan(Date.now());
    const [event] = await auditFor(h.knex, { actor_user_id: user.id, reason: 'account_locked' });
    expect(event.outcome).toBe('denied');

    // Lock expires → the correct password works again and the counter resets.
    await h
      .knex('users')
      .where({ email })
      .update({ locked_until: new Date(Date.now() - 1000) });
    expect((await login(h.app, { email })).status).toBe(200);
  });

  it('disabled accounts cannot sign in', async () => {
    const email = uniqueEmail('disabled');
    await register(h.app, { email });
    await h.knex('users').where({ email }).update({ status: 'disabled' });
    const res = await login(h.app, { email });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('account_unavailable');
  });
});

describe('session lifecycle', () => {
  it('refresh rotates the refresh token and issues a new access token', async () => {
    const { session } = await createUser(h, { label: 'refresh' });
    const res = await refresh(session);
    expect(res.status).toBe(200);
    const next = sessionFrom(res);
    expect(next.refreshToken).not.toBe(session.refreshToken);
    expect(next.refreshToken.split('.')[0]).toBe(session.refreshToken.split('.')[0]); // same session
    expect(next.accessToken).not.toBe(session.accessToken);
    expect((await request(h.app).get('/api/v1/auth/me').set(authHeader(next))).status).toBe(200);
  });

  it('treats an immediate replay of the previous token as a benign race (no revocation)', async () => {
    const { session } = await createUser(h, { label: 'race' });
    const rotated = sessionFrom(await refresh(session));
    const replay = await refresh(session);
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('refresh_conflict');
    expect((await refresh(rotated)).status).toBe(200);
  });

  it('detects refresh-token reuse after the grace window and revokes the session', async () => {
    const { session, id } = await createUser(h, { label: 'reuse' });
    const rotated = sessionFrom(await refresh(session));
    const sessionId = session.refreshToken.split('.')[0];
    await h
      .knex('sessions')
      .where({ id: sessionId })
      .update({ rotated_at: new Date(Date.now() - 60_000) });

    const replay = await refresh(session);
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('session_invalid');
    expect(parseSetCookies(replay).hb_refresh.value).toBe(''); // cookies cleared

    // The legitimate holder is also signed out: the whole session is dead.
    expect((await refresh(rotated)).status).toBe(401);
    expect((await request(h.app).get('/api/v1/auth/me').set(authHeader(rotated))).status).toBe(401);
    const row = await h.knex('sessions').where({ id: sessionId }).first();
    expect(row.revoked_reason).toBe('refresh_token_reuse');
    const [event] = await auditFor(h.knex, { actor_user_id: id, reason: 'refresh_token_reuse' });
    expect(event).toMatchObject({ action: 'auth.refresh', outcome: 'denied' });
  });

  it('rejects refresh without a valid CSRF token, without revoking', async () => {
    const { session } = await createUser(h, { label: 'csrf' });
    const noHeader = await refresh(session, { csrf: null });
    expect(noHeader.status).toBe(403);
    const forged = await request(h.app)
      .post('/api/v1/auth/refresh')
      .set({
        ...cookieHeaders(session),
        Cookie: `hb_refresh=${session.refreshToken}; hb_csrf=forged`,
        'X-CSRF-Token': 'forged',
      });
    expect(forged.status).toBe(403);
    expect(forged.body.code).toBe('csrf_token_invalid');
    expect((await refresh(session)).status).toBe(200);
  });

  it('logout revokes the session: refresh and access token stop working immediately', async () => {
    const { session } = await createUser(h, { label: 'logout' });
    const res = await request(h.app).post('/api/v1/auth/logout').set(cookieHeaders(session)).send();
    expect(res.status).toBe(204);
    expect(parseSetCookies(res).hb_refresh.value).toBe('');

    expect((await refresh(session)).status).toBe(401);
    const me = await request(h.app).get('/api/v1/auth/me').set(authHeader(session));
    expect(me.status).toBe(401);
    expect(me.body.code).toBe('session_invalid');
  });

  it('expired sessions are rejected on refresh and for access tokens', async () => {
    const { session } = await createUser(h, { label: 'expired' });
    const sessionId = session.refreshToken.split('.')[0];
    const past = new Date(Date.now() - 1000);
    await h.knex('sessions').where({ id: sessionId }).update({ idle_expires_at: past });

    expect((await request(h.app).get('/api/v1/auth/me').set(authHeader(session))).status).toBe(401);
    const res = await refresh(session);
    expect(res.status).toBe(401);
    expect((await h.knex('sessions').where({ id: sessionId }).first()).revoked_reason).toBe(
      'expired',
    );
  });

  it('lists own sessions and revokes another one of them', async () => {
    const user = await createUser(h, { label: 'multi' });
    const second = sessionFrom(await login(h.app, { email: user.email }));

    const list = await request(h.app).get('/api/v1/auth/sessions').set(authHeader(user.session));
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(2);
    expect(list.body.data.filter((s) => s.current)).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toMatch(/hash|refresh/i);

    const secondId = second.refreshToken.split('.')[0];
    const del = await request(h.app)
      .delete(`/api/v1/auth/sessions/${secondId}`)
      .set(authHeader(user.session));
    expect(del.status).toBe(204);
    expect((await request(h.app).get('/api/v1/auth/me').set(authHeader(second))).status).toBe(401);
    expect((await request(h.app).get('/api/v1/auth/me').set(authHeader(user.session))).status).toBe(
      200,
    );
  });

  it('password change revokes all other sessions', async () => {
    const user = await createUser(h, { label: 'pwchange' });
    const other = sessionFrom(await login(h.app, { email: user.email }));
    const res = await request(h.app)
      .post('/api/v1/users/me/password')
      .set(authHeader(user.session))
      .send({ currentPassword: PASSWORD, newPassword: 'a brand new synthetic phrase' });
    expect(res.status).toBe(200);
    expect(res.body.data.otherSessionsRevoked).toBe(1);
    expect((await request(h.app).get('/api/v1/auth/me').set(authHeader(other))).status).toBe(401);
    expect((await request(h.app).get('/api/v1/auth/me').set(authHeader(user.session))).status).toBe(
      200,
    );
    expect((await login(h.app, { email: user.email })).status).toBe(401);
    expect(
      (await login(h.app, { email: user.email, password: 'a brand new synthetic phrase' })).status,
    ).toBe(200);
  });

  it('password change requires the current password', async () => {
    const user = await createUser(h, { label: 'pwwrong' });
    const res = await request(h.app)
      .post('/api/v1/users/me/password')
      .set(authHeader(user.session))
      .send({
        currentPassword: 'not my password at all',
        newPassword: 'a brand new synthetic phrase',
      });
    expect(res.status).toBe(400);
    expect(res.body.errors[0].path).toBe('body.currentPassword');
  });

  it('privileged roles get shorter sessions than patients', async () => {
    const patient = await createUser(h, { label: 'ttl-patient' });
    const doctor = await createUser(h, { label: 'ttl-doctor', roles: ['DOCTOR'] });
    const expiry = async (s) =>
      (
        await h
          .knex('sessions')
          .where({ id: s.refreshToken.split('.')[0] })
          .first()
      ).absolute_expires_at;
    expect((await expiry(doctor.session)).getTime()).toBeLessThan(
      (await expiry(patient.session)).getTime(),
    );
  });
});
