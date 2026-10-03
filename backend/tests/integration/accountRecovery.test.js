import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  PASSWORD,
  auditFor,
  authHeader,
  createHarness,
  login,
  register,
  sessionFrom,
  uniqueEmail,
} from './harness.js';
import { sha256Hex } from '../../src/core/auth/secrets.js';

let h;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

const NEW_PASSWORD = 'quiet harbour violet 2026';
const post = (path, body) => request(h.app).post(`/api/v1${path}`).send(body);

async function waitForMail(to, template, { after = 0, timeout = 5_000 } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const found = h.mailer.sent.slice(after).find((m) => m.to === to && m.template === template);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`no ${template} email for ${to}`);
}
const tokenFrom = (mail, path) => {
  const match = mail.text.match(new RegExp(`/${path}#token=([^\\s]+)`));
  expect(match, 'link with token in the fragment').toBeTruthy();
  return match[1];
};

describe('password reset', () => {
  it('emails a single-use link, resets the password and signs out everywhere', async () => {
    const email = uniqueEmail('reset');
    await register(h.app, { email });
    const session = sessionFrom(await login(h.app, { email }));
    const mark = h.mailer.sent.length;

    const res = await post('/auth/password/forgot', { email });
    expect(res.status).toBe(202);
    expect(res.headers['cache-control']).toBe('no-store');
    const mail = await waitForMail(email, 'password_reset', { after: mark });
    expect(mail.text).toContain('http://');
    const token = tokenFrom(mail, 'reset-password');

    // Only the hash is stored; the token never reaches logs or the audit trail.
    const [id, secret] = token.split('.');
    const row = await h.ownerKnex('account_tokens').where({ id }).first();
    expect(row).toMatchObject({ purpose: 'password_reset', token_hash: sha256Hex(secret) });
    expect(row.expires_at - row.created_at).toBe(30 * 60_000);

    const done = await post('/auth/password/reset', { token, newPassword: NEW_PASSWORD });
    expect(done.status).toBe(200);
    expect(done.body.data).toEqual({ status: 'password_reset' });

    // Every existing session is revoked; the old password no longer works.
    const me = await request(h.app).get('/api/v1/auth/me').set(authHeader(session));
    expect(me.status).toBe(401);
    expect((await post('/auth/login', { email, password: PASSWORD })).status).toBe(401);
    expect((await post('/auth/login', { email, password: NEW_PASSWORD })).status).toBe(200);
    await waitForMail(email, 'password_changed', { after: mark });

    // Single use.
    const again = await post('/auth/password/reset', {
      token,
      newPassword: 'another long phrase 99',
    });
    expect(again.status).toBe(400);
    expect(again.body.code).toBe('invalid_token');

    const serialized = JSON.stringify(h.logs) + JSON.stringify(await auditFor(h.knex, {}));
    expect(serialized).not.toContain(secret);
    const [event] = await auditFor(h.knex, { action: 'auth.password_reset', outcome: 'success' });
    expect(event).toBeTruthy();
  });

  it('answers identically for unknown emails and sends nothing', async () => {
    const email = uniqueEmail('nobody');
    const mark = h.mailer.sent.length;
    const res = await post('/auth/password/forgot', { email });
    expect(res.status).toBe(202);
    const known = uniqueEmail('somebody');
    await register(h.app, { email: known });
    const res2 = await post('/auth/password/forgot', { email: known });
    expect(res2.body).toEqual(res.body);
    await waitForMail(known, 'password_reset', { after: mark });
    expect(h.mailer.sent.slice(mark).some((m) => m.to === email)).toBe(false);
  });

  it('rejects expired, replaced, tampered and malformed tokens', async () => {
    const email = uniqueEmail('reset-bad');
    await register(h.app, { email });
    const mark = h.mailer.sent.length;
    await post('/auth/password/forgot', { email });
    const first = tokenFrom(
      await waitForMail(email, 'password_reset', { after: mark }),
      'reset-password',
    );
    const mark2 = h.mailer.sent.length;
    await post('/auth/password/forgot', { email });
    const second = tokenFrom(
      await waitForMail(email, 'password_reset', { after: mark2 }),
      'reset-password',
    );

    const reset = (token) => post('/auth/password/reset', { token, newPassword: NEW_PASSWORD });
    // A newer link replaces the older one.
    expect((await reset(first)).body.code).toBe('invalid_token');
    // Tampered secret.
    const [id] = second.split('.');
    expect((await reset(`${id}.${'A'.repeat(43)}`)).body.code).toBe('invalid_token');
    // Malformed tokens fail validation.
    expect((await reset('not-a-token')).status).toBe(400);

    // Expired.
    const user = await h.ownerKnex('users').where({ email }).first('id');
    const expiredId = randomUUID();
    const secret = 'B'.repeat(43);
    await h.ownerKnex('account_tokens').insert({
      id: expiredId,
      user_id: user.id,
      purpose: 'password_reset',
      token_hash: sha256Hex(secret),
      created_at: new Date(Date.now() - 2 * 3600_000),
      expires_at: new Date(Date.now() - 3600_000),
    });
    expect((await reset(`${expiredId}.${secret}`)).body.code).toBe('invalid_token');

    // The still-valid link enforces the password policy (no name or email).
    const weak = await post('/auth/password/reset', {
      token: second,
      newPassword: `${email} long`,
    });
    expect(weak.body.code).toBe('validation_failed');
    expect((await reset(second)).status).toBe(200);
  });

  it('lifts an account lockout', async () => {
    const email = uniqueEmail('locked');
    await register(h.app, { email });
    await h
      .ownerKnex('users')
      .where({ email })
      .update({ locked_until: new Date(Date.now() + 600_000) });
    const mark = h.mailer.sent.length;
    await post('/auth/password/forgot', { email });
    const token = tokenFrom(
      await waitForMail(email, 'password_reset', { after: mark }),
      'reset-password',
    );
    expect((await post('/auth/password/reset', { token, newPassword: NEW_PASSWORD })).status).toBe(
      200,
    );
    expect((await post('/auth/login', { email, password: NEW_PASSWORD })).status).toBe(200);
  });

  it('tokens are consume-only for the application role', async () => {
    const email = uniqueEmail('token-guard');
    await register(h.app, { email });
    const mark = h.mailer.sent.length;
    await post('/auth/password/forgot', { email });
    const [id] = tokenFrom(
      await waitForMail(email, 'password_reset', { after: mark }),
      'reset-password',
    ).split('.');
    await expect(h.knex('account_tokens').where({ id }).del()).rejects.toThrow(/permission denied/);
    await expect(
      h
        .knex('account_tokens')
        .where({ id })
        .update({ expires_at: new Date(Date.now() + 3600_000) }),
    ).rejects.toThrow(/only be consumed once/);
  });
});

describe('email verification', () => {
  it('new accounts get a link; verifying is single-use; resending reports the state', async () => {
    const email = uniqueEmail('verify');
    const mark = h.mailer.sent.length;
    await register(h.app, { email });
    const token = tokenFrom(
      await waitForMail(email, 'email_verification', { after: mark }),
      'verify-email',
    );

    const session = sessionFrom(await login(h.app, { email }));
    const before = await h.ownerKnex('users').where({ email }).first('email_verified_at');
    expect(before.email_verified_at).toBeNull();

    expect((await post('/auth/email/verify', { token })).body.data).toEqual({ status: 'verified' });
    const user = await h.ownerKnex('users').where({ email }).first('email_verified_at');
    expect(user.email_verified_at).toBeInstanceOf(Date);
    expect((await post('/auth/email/verify', { token })).status).toBe(400);

    const resend = await request(h.app)
      .post('/api/v1/users/me/email-verification')
      .set(authHeader(session));
    expect(resend.status).toBe(202);
    expect(resend.body.data).toEqual({ status: 'already_verified' });
  });
});
