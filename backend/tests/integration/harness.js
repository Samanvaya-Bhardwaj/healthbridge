// Shared setup for integration tests against real PostgreSQL and Redis.
// Prerequisites: data services running and migrations applied (see docs/DEVELOPMENT.md).

import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { CSRF_COOKIE } from '@healthbridge/shared';
import { loadConfig } from '../../src/config/index.js';
import { createLogger } from '../../src/core/logger/index.js';
import { createKnex } from '../../src/core/db/knex.js';
import { createRedis } from '../../src/core/cache/redis.js';
import { createMemoryMailer } from '../../src/core/mail/mailer.js';
import { createContainer } from '../../src/container.js';
import { createApp } from '../../src/app.js';
import { REFRESH_COOKIE } from '../../src/core/auth/cookies.js';
import { FAST_HASH_PARAMS, TEST_ORIGIN, captureLogs, testSigningKey } from '../helpers.js';

const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

export const TEST_EMAIL_DOMAIN = 'test.healthbridge.local';
export const PASSWORD = 'synthetic river lantern 2026';

const GENEROUS = { points: 100_000, durationSeconds: 60 };
const NO_LIMITS = {
  global: GENEROUS,
  register: GENEROUS,
  loginIp: GENEROUS,
  loginAccount: GENEROUS,
  refresh: GENEROUS,
  passwordChange: GENEROUS,
};

export const uniqueEmail = (label = 'user') =>
  `${label}.${randomUUID().slice(0, 8)}@${TEST_EMAIL_DOMAIN}`;

/**
 * @param {{ rateLimits?: object, env?: Record<string, string> }} [options]
 */
export async function createHarness({ rateLimits = {}, env = {} } = {}) {
  const config = loadConfig({
    ...process.env,
    AI_SERVICE_URL: process.env.AI_SERVICE_URL ?? 'http://localhost:8000',
    AUTH_JWT_PRIVATE_KEY: process.env.AUTH_JWT_PRIVATE_KEY ?? testSigningKey(),
    AUTH_COOKIE_SECURE: 'false',
    CORS_ORIGINS: TEST_ORIGIN,
    APP_ENV: 'test',
    ...env,
  });
  const { lines: logs, destination } = captureLogs();
  const logger = createLogger({ level: 'info', appEnv: 'test', destination });
  const knex = createKnex(config.db, 'healthbridge-integration-test');
  const redis = createRedis(config.redis, 'healthbridge-integration-test');
  await redis.connect();
  // Rate-limit counters from earlier runs must not leak into this one.
  const keys = await redis.keys('rl:*');
  if (keys.length) await redis.del(...keys);

  const mailer = createMemoryMailer();
  const container = createContainer({
    config,
    logger,
    knex,
    redis,
    mailer,
    passwordHashParams: FAST_HASH_PARAMS,
    rateLimits: { ...NO_LIMITS, ...rateLimits },
  });
  const app = createApp({ config, logger, container, redis, healthChecks: [], version: 'test' });

  async function close() {
    await knex('users').where('email', 'like', `%@${TEST_EMAIL_DOMAIN}`).del();
    await Promise.allSettled([knex.destroy(), redis.quit()]);
  }

  return { app, config, container, knex, redis, mailer, logs, close };
}

/** Parses Set-Cookie headers into { name: { value, attributes } }. */
export function parseSetCookies(res) {
  const cookies = {};
  for (const header of res.headers['set-cookie'] ?? []) {
    const [pair, ...attrs] = header.split(';').map((s) => s.trim());
    const index = pair.indexOf('=');
    cookies[pair.slice(0, index)] = {
      value: decodeURIComponent(pair.slice(index + 1)),
      attributes: attrs.map((a) => a.toLowerCase()),
      raw: header,
    };
  }
  return cookies;
}

/** Session helper mirroring what the browser holds after login/refresh. */
export function sessionFrom(res) {
  const cookies = parseSetCookies(res);
  return {
    accessToken: res.body.data?.accessToken,
    refreshToken: cookies[REFRESH_COOKIE]?.value,
    csrfToken: cookies[CSRF_COOKIE]?.value,
    user: res.body.data?.user,
  };
}

export const authHeader = (session) => ({ Authorization: `Bearer ${session.accessToken}` });

export const cookieHeaders = (session, { csrf = session.csrfToken } = {}) => ({
  Origin: TEST_ORIGIN,
  Cookie: `${REFRESH_COOKIE}=${session.refreshToken}; ${CSRF_COOKIE}=${session.csrfToken}`,
  ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
});

export async function register(app, { email, password = PASSWORD, fullName = 'Riya Kapoor' }) {
  return request(app)
    .post('/api/v1/auth/register')
    .send({ email, password, fullName, acceptTerms: true });
}

export async function login(app, { email, password = PASSWORD }) {
  return request(app).post('/api/v1/auth/login').send({ email, password });
}

/** Registers a user (PATIENT by default, or exactly the given staff roles) and logs in. */
export async function createUser(harness, { label = 'user', roles = [] } = {}) {
  const email = uniqueEmail(label);
  await register(harness.app, { email });
  const row = await harness.knex('users').where({ email }).first('id');
  // Staff accounts are provisioned with their staff roles only (not the self-registration PATIENT role).
  for (const role of roles) await harness.container.repositories.roles.grant(row.id, role, null);
  if (roles.length && !roles.includes('PATIENT')) {
    await harness.container.repositories.roles.revoke(row.id, 'PATIENT');
  }
  const res = await login(harness.app, { email });
  if (res.status !== 200) throw new Error(`login failed for ${label}: ${res.status}`);
  return { email, id: row.id, session: sessionFrom(res) };
}

export async function auditFor(knex, filter) {
  return knex('audit.audit_logs').where(filter).orderBy('occurred_at', 'desc');
}
