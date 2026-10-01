import { Writable } from 'node:stream';
import { loadConfig } from '../src/config/index.js';
import { createLogger } from '../src/core/logger/index.js';
import { createApp } from '../src/app.js';

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
  CORS_ORIGINS: 'http://localhost:5173',
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

const ok = async () => {};

/** App with stubbed dependencies (no Redis → in-memory rate limiter). */
export function buildTestApp({ healthChecks, env = {} } = {}) {
  const config = loadConfig({ ...validEnv, ...env });
  const { lines, destination } = captureLogs();
  const logger = createLogger({ level: 'info', appEnv: 'test', destination });
  const app = createApp({
    config,
    logger,
    version: '0.1.0-test',
    healthChecks: healthChecks ?? [
      { name: 'database', critical: true, check: ok },
      { name: 'aiService', critical: false, check: ok },
    ],
  });
  return { app, logs: lines, config };
}
