import { generateKeyPairSync } from 'node:crypto';
import { Writable } from 'node:stream';
import { loadConfig } from '../src/config/index.js';
import { createLogger } from '../src/core/logger/index.js';
import { createKnex } from '../src/core/db/knex.js';
import { createMemoryMailer } from '../src/core/mail/mailer.js';
import { createContainer } from '../src/container.js';
import { createApp } from '../src/app.js';

/** Fresh Ed25519 key for tests (never a real key). */
export function testSigningKey() {
  const { privateKey } = generateKeyPairSync('ed25519');
  return Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64');
}

export const TEST_ORIGIN = 'http://localhost:5173';

export const validEnv = Object.freeze({
  APP_ENV: 'test',
  NODE_ENV: 'test',
  LOG_LEVEL: 'info',
  DB_HOST: 'localhost',
  POSTGRES_DB: 'healthbridge',
  DB_APP_USER: 'hb_app',
  DB_APP_PASSWORD: 'test-password',
  REDIS_HOST: 'localhost',
  REDIS_PASSWORD: 'test-password',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_REGION: 'ap-south-1',
  S3_ACCESS_KEY_ID: 'test',
  S3_SECRET_ACCESS_KEY: 'test-secret',
  S3_BUCKET_DOCUMENTS: 'healthbridge-documents',
  AI_SERVICE_URL: 'http://localhost:8000',
  INTERNAL_SERVICE_SECRET: 'x'.repeat(48),
  CORS_ORIGINS: TEST_ORIGIN,
  AUTH_JWT_PRIVATE_KEY: testSigningKey(),
  AUTH_COOKIE_SECURE: 'false',
});

/** Captures structured log lines for assertions. */
export function captureLogs() {
  const lines = [];
  const destination = new Writable({
    write(chunk, _enc, cb) {
      lines.push(
        ...chunk
          .toString()
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l)),
      );
      cb();
    },
  });
  return { lines, destination };
}

/** Argon2id parameters reduced for test speed only. */
export const FAST_HASH_PARAMS = Object.freeze({ memoryCost: 4096, timeCost: 1, parallelism: 1 });

const ok = async () => {};

/**
 * App with stubbed infrastructure. The Knex instance is lazy (never connects unless a
 * test hits a database-backed route), Redis is absent (in-memory rate limiting).
 */
export function buildTestApp({ healthChecks, env = {} } = {}) {
  const config = loadConfig({ ...validEnv, ...env });
  const { lines, destination } = captureLogs();
  const logger = createLogger({ level: 'info', appEnv: 'test', destination });
  const knex = createKnex(config.db);
  const container = createContainer({
    config,
    logger,
    knex,
    mailer: createMemoryMailer(),
    passwordHashParams: FAST_HASH_PARAMS,
  });
  const app = createApp({
    config,
    logger,
    container,
    version: '0.1.0-test',
    healthChecks: healthChecks ?? [
      { name: 'database', critical: true, check: ok },
      { name: 'aiService', critical: false, check: ok },
    ],
  });
  return { app, logs: lines, config, container };
}
