#!/usr/bin/env node
// Generates a local-development .env with random secrets and free host ports.
// Usage: node scripts/generate-env.mjs [--force | --update]
//   --force   overwrite everything (rotates all secrets; requires `docker compose down -v`)
//   --update  keep existing values and append only variables that are missing
// Never use the generated file for staging/production.

import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, '.env');
const force = process.argv.includes('--force');
const update = process.argv.includes('--update');

if (existsSync(target) && !force && !update) {
  console.error(
    '.env already exists. Use --update to add missing variables, or --force to overwrite ' +
      '(this rotates all local secrets).',
  );
  process.exit(1);
}

const secret = (bytes = 32) => randomBytes(bytes).toString('base64url');
const anthropicKey = process.env.ANTHROPIC_API_KEY ?? '';

/** Ed25519 signing key for access tokens: PKCS#8 PEM, base64-encoded onto one line. */
function ed25519PrivateKey() {
  const { privateKey } = generateKeyPairSync('ed25519');
  return Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64');
}

const isFree = (port) =>
  new Promise((resolve) => {
    const server = createServer()
      .once('error', () => resolve(false))
      .once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });

/** Returns `preferred` if free, otherwise the next free port (avoids clashing with local services). */
async function freePort(preferred, taken) {
  for (let port = preferred; port < preferred + 100; port += 1) {
    if (!taken.has(port) && (await isFree(port))) {
      taken.add(port);
      return port;
    }
  }
  throw new Error(`No free port found near ${preferred}`);
}

const PREFERRED_PORTS = {
  HOST_PORT_POSTGRES: 5432,
  HOST_PORT_REDIS: 6379,
  HOST_PORT_MINIO: 9000,
  HOST_PORT_MINIO_CONSOLE: 9001,
  HOST_PORT_MAILPIT_UI: 8025,
  HOST_PORT_SMTP: 1025,
  HOST_PORT_API: 4000,
  HOST_PORT_WEB: 8080,
};
const taken = new Set();
const ports = {};
for (const [name, preferred] of Object.entries(PREFERRED_PORTS)) {
  ports[name] = update ? preferred : await freePort(preferred, taken);
}

const minioPassword = secret();
const values = {
  APP_ENV: 'development',
  DEMO_MODE: 'true',
  LOG_LEVEL: 'info',

  ...Object.fromEntries(Object.entries(ports).map(([k, v]) => [k, String(v)])),

  DB_HOST: 'localhost',
  DB_PORT: String(ports.HOST_PORT_POSTGRES),
  POSTGRES_DB: 'healthbridge',
  POSTGRES_USER: 'hb_owner',
  POSTGRES_PASSWORD: secret(),
  DB_APP_USER: 'hb_app',
  DB_APP_PASSWORD: secret(),
  DB_AI_USER: 'hb_ai',
  DB_AI_PASSWORD: secret(),
  DB_POOL_MAX: '10',

  REDIS_HOST: 'localhost',
  REDIS_PORT: String(ports.HOST_PORT_REDIS),
  REDIS_PASSWORD: secret(),

  S3_ENDPOINT: `http://localhost:${ports.HOST_PORT_MINIO}`,
  S3_REGION: 'ap-south-1',
  // Local MinIO only: the backend uses the root credentials. Production uses a scoped IAM identity.
  S3_ACCESS_KEY_ID: 'hb-minio-admin',
  S3_SECRET_ACCESS_KEY: minioPassword,
  S3_BUCKET_DOCUMENTS: 'healthbridge-documents',
  S3_FORCE_PATH_STYLE: 'true',
  MINIO_ROOT_USER: 'hb-minio-admin',
  MINIO_ROOT_PASSWORD: minioPassword,

  SMTP_HOST: 'localhost',
  SMTP_PORT: String(ports.HOST_PORT_SMTP),
  MAIL_FROM: '"HealthBridge Demo <no-reply@healthbridge.local>"',

  API_PORT: '4000',
  METRICS_PORT: '9464',
  CORS_ORIGINS: `http://localhost:5173,http://localhost:${ports.HOST_PORT_WEB}`,
  TRUST_PROXY: '0',

  AI_SERVICE_URL: 'http://localhost:8000',
  INTERNAL_SERVICE_SECRET: secret(48),

  LLM_PROVIDER: anthropicKey ? 'claude' : 'fake',
  ANTHROPIC_API_KEY: anthropicKey,
  LLM_MODEL_DEFAULT: 'claude-opus-5-5',
  LLM_MODEL_FAST: 'claude-haiku-4-5',
  LLM_TIMEOUT_SECONDS: '60',
  LLM_MAX_RETRIES: '2',
  LLM_REFUSAL_FALLBACK: 'true',
  LLM_EXTERNAL_PROCESSING_APPROVED: 'false',

  AUTH_JWT_PRIVATE_KEY: ed25519PrivateKey(),
  AUTH_ACCESS_TOKEN_TTL_SECONDS: '600',
  // Plain-HTTP localhost only. Config refuses insecure cookies in staging/production.
  AUTH_COOKIE_SECURE: 'false',
  // Password for the synthetic demo accounts created by `npm run seed:demo -w backend`.
  DEMO_USER_PASSWORD: secret(18),

  // Payments (ADR-0020): the fake provider moves no money. Its webhooks are signed with
  // this local secret. Razorpay test keys are added by hand only when needed.
  PAYMENT_PROVIDER: 'fake',
  PAYMENT_WEBHOOK_SECRET: secret(32),
  // Mailpit locally (see SMTP_HOST); tests use an in-memory provider.
  NOTIFICATION_EMAIL_PROVIDER: 'smtp',
};

if (update && existsSync(target)) {
  const existing = readFileSync(target, 'utf8');
  const present = new Set(
    existing
      .split(/\r?\n/)
      .map((line) => /^([A-Z0-9_]+)=/.exec(line)?.[1])
      .filter(Boolean),
  );
  const missing = Object.entries(values).filter(([key]) => !present.has(key));
  if (!missing.length) {
    console.log('.env is up to date.');
    process.exit(0);
  }
  const suffix = existing.endsWith('\n') ? '' : '\n';
  const additions = missing.map(([k, v]) => `${k}=${v}`).join('\n');
  writeFileSync(target, `${existing}${suffix}${additions}\n`, { mode: 0o600 });
  console.log(`Added to .env: ${missing.map(([k]) => k).join(', ')}`);
  process.exit(0);
}

const body = [
  '# Generated by scripts/generate-env.mjs for LOCAL DEVELOPMENT ONLY. Do not commit.',
  '# Host-side values (DB_HOST=localhost, ports) are for tools run on the host;',
  '# docker-compose.yml overrides hostnames/ports inside containers.',
  ...Object.entries(values).map(([k, v]) => `${k}=${v}`),
  '',
].join('\n');

writeFileSync(target, body, { mode: 0o600 });
console.log(`Wrote ${target}`);
const moved = Object.entries(ports).filter(([k, v]) => v !== PREFERRED_PORTS[k]);
if (moved.length) {
  console.log(
    `Ports in use on this machine were remapped: ${moved.map(([k, v]) => `${k}=${v}`).join(', ')}`,
  );
}
console.log(`Web app will be at http://localhost:${ports.HOST_PORT_WEB}`);
console.log(
  values.LLM_PROVIDER === 'fake'
    ? 'LLM_PROVIDER=fake (no ANTHROPIC_API_KEY in your shell). Add a key to .env and set LLM_PROVIDER=claude to use Claude.'
    : 'LLM_PROVIDER=claude (ANTHROPIC_API_KEY taken from your shell).',
);
