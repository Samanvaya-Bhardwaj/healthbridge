// Shared setup for integration tests against real PostgreSQL and Redis.
// Prerequisites: data services running and migrations applied (see docs/DEVELOPMENT.md).

import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import knexFactory from 'knex';
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

  // Cleanup needs the owner role: the application role cannot delete patient-scoped
  // rows (no RLS DELETE policy), by design. Audit rows are append-only and remain.
  const { migrationConfig } = await import('../../knexfile.js');
  const ownerKnex = knexFactory(migrationConfig(process.env));

  async function close() {
    const testUsers = ownerKnex('users')
      .select('id')
      .where('email', 'like', `%@${TEST_EMAIL_DOMAIN}`);
    const testPatients = ownerKnex('patients')
      .select('id')
      .whereIn('created_by_user_id', testUsers.clone());
    const testDoctors = ownerKnex('doctors').select('id').whereIn('user_id', testUsers.clone());
    const testClinics = ownerKnex('clinics')
      .select('id')
      .whereIn('created_by_user_id', testUsers.clone());
    await ownerKnex.transaction(async (trx) => {
      const testAppointments = trx('appointments')
        .select('id')
        .whereIn('patient_id', testPatients.clone())
        .orWhereIn('doctor_id', testDoctors.clone());
      await trx('appointment_intakes').whereIn('appointment_id', testAppointments.clone()).del();
      await trx('appointments')
        .whereIn('id', testAppointments.clone())
        .whereNotNull('rescheduled_from_id')
        .del();
      await trx('appointments').whereIn('id', testAppointments.clone()).del();
      await trx('availability_exceptions').whereIn('doctor_id', testDoctors.clone()).del();
      await trx('availability_rules').whereIn('doctor_id', testDoctors.clone()).del();
      await trx('care_relationships')
        .whereIn('patient_id', testPatients.clone())
        .orWhereIn('doctor_id', testDoctors.clone())
        .orWhereIn('clinic_id', testClinics.clone())
        .del();
      await trx('patient_guardianships').whereIn('patient_id', testPatients.clone()).del();
      await trx('patients').whereIn('id', testPatients.clone()).del();
      await trx('doctor_verifications').whereIn('doctor_id', testDoctors.clone()).del();
      await trx('doctors').whereIn('id', testDoctors.clone()).del();
      await trx('clinic_memberships')
        .whereIn('user_id', testUsers.clone())
        .orWhereIn('clinic_id', testClinics.clone())
        .del();
      await trx('user_roles')
        .whereIn('user_id', testUsers.clone())
        .orWhereIn('clinic_id', testClinics.clone())
        .del();
      await trx('clinics').whereIn('id', testClinics.clone()).del();
      await trx('users').whereIn('id', testUsers.clone()).del();
    });
    await Promise.allSettled([knex.destroy(), ownerKnex.destroy(), redis.quit()]);
  }

  return { app, config, container, knex, ownerKnex, redis, mailer, logs, close };
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
export async function createUser(harness, { label = 'user', roles = [], clinic } = {}) {
  const email = uniqueEmail(label);
  await register(harness.app, { email });
  const row = await harness.knex('users').where({ email }).first('id');
  // Staff accounts are provisioned with their staff roles only (not the self-registration
  // PATIENT role). Clinic-scoped roles are granted for a clinic with an active membership.
  for (const role of roles) {
    if (role === 'CLINIC_ADMIN') {
      const clinicId = clinic ?? (await createTestClinic(harness));
      await harness.knex('clinic_memberships').insert({
        id: randomUUID(),
        clinic_id: clinicId,
        user_id: row.id,
        member_role: 'CLINIC_ADMIN',
        status: 'active',
        joined_at: new Date(),
      });
      await harness.container.repositories.roles.grant(row.id, role, null, undefined, { clinicId });
    } else {
      await harness.container.repositories.roles.grant(row.id, role, null);
    }
  }
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

/** Creates an active test clinic (owned by a throwaway creator account) and returns its id. */
export async function createTestClinic(
  harness,
  { name = `Test Clinic ${randomUUID().slice(0, 6)}` } = {},
) {
  const creatorEmail = uniqueEmail('clinic-creator');
  await register(harness.app, { email: creatorEmail });
  const creator = await harness.knex('users').where({ email: creatorEmail }).first('id');
  const id = randomUUID();
  await harness
    .knex('clinics')
    .insert({ id, name, city: 'Test City', created_by_user_id: creator.id });
  return id;
}
