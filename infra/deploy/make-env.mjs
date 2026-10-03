#!/usr/bin/env node
// Generates the environment file for a single-host staging or production deployment
// (infra/deploy/compose.prod.yml) with fresh random secrets (ADR-0028).
//
//   node infra/deploy/make-env.mjs --env staging --domain staging.example.org \
//     --age-recipient age1… --version v1.0.0 > /etc/healthbridge/healthbridge.env
//
// Store the output only on the server (mode 600) and in your secret manager. Never
// commit it. Provider credentials (SMTP relay, Razorpay live keys, LiveKit, Anthropic)
// are left blank for an operator to fill in; the application refuses to start in
// production until they are valid.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    env: { type: 'string', default: 'staging' },
    domain: { type: 'string' },
    'https-port': { type: 'string', default: '443' },
    'age-recipient': { type: 'string' },
    version: { type: 'string', default: '' },
    registry: { type: 'string', default: 'ghcr.io/samanvaya-bhardwaj' },
    demo: { type: 'boolean', default: false },
  },
});

if (!['staging', 'production'].includes(args.env)) throw new Error('--env staging|production');
if (!args.domain) throw new Error('--domain is required');
if (!args['age-recipient']?.startsWith('age1')) {
  throw new Error('--age-recipient (age public key; keep the private key offline) is required');
}
if (args.demo && args.env === 'production')
  throw new Error('demo data is never allowed in production');

const secret = (bytes = 32) => randomBytes(bytes).toString('base64url');
const { privateKey } = generateKeyPairSync('ed25519');
const port = args['https-port'] === '443' ? '' : `:${args['https-port']}`;
const appUrl = `https://${args.domain}${port}`;
const minioPassword = secret();

const values = {
  HB_VERSION: args.version,
  HB_REGISTRY: args.registry,
  HB_DOMAIN: args.domain,
  HB_ACME_EMAIL: '',
  HB_HTTPS_PORT: args['https-port'],
  APP_ENV: args.env,
  DEMO_MODE: String(args.demo),
  LOG_LEVEL: 'info',
  PUBLIC_APP_URL: appUrl,

  POSTGRES_DB: 'healthbridge',
  POSTGRES_USER: 'hb_owner',
  POSTGRES_PASSWORD: secret(),
  DB_APP_USER: 'hb_app',
  DB_APP_PASSWORD: secret(),
  DB_AI_USER: 'hb_ai',
  DB_AI_PASSWORD: secret(),
  REDIS_PASSWORD: secret(),

  MINIO_ROOT_USER: 'hb-minio-admin',
  MINIO_ROOT_PASSWORD: minioPassword,
  S3_ACCESS_KEY_ID: 'hb-minio-admin',
  S3_SECRET_ACCESS_KEY: minioPassword,
  // Fixed: the web container proxies this bucket path on the app origin.
  S3_BUCKET_DOCUMENTS: 'healthbridge-documents',

  SMTP_HOST: '',
  SMTP_PORT: '587',
  SMTP_USER: '',
  SMTP_PASSWORD: '',
  MAIL_FROM: `"HealthBridge <no-reply@${args.domain}>"`,

  INTERNAL_SERVICE_SECRET: secret(48),
  AUTH_JWT_PRIVATE_KEY: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString(
    'base64',
  ),
  DEMO_USER_PASSWORD: args.demo ? secret(18) : '',
  PAYMENT_PROVIDER: args.env === 'production' ? 'razorpay' : 'fake',
  PAYMENT_WEBHOOK_SECRET: secret(32),
  RAZORPAY_KEY_ID: '',
  RAZORPAY_KEY_SECRET: '',
  CLINICAL_DATA_KEY: randomBytes(32).toString('base64'),
  CLINICAL_DATA_KEY_ID: 'k1',
  VIDEO_PROVIDER: 'mock',
  LLM_PROVIDER: 'fake',
  LLM_EXTERNAL_PROCESSING_APPROVED: 'false',

  BULL_BOARD_PASSWORD: secret(18),
  BACKUP_AGE_RECIPIENT: args['age-recipient'],
  BACKUP_OBJECTS_PASSWORD: secret(32),
  BACKUP_REMOTE: '',
};

process.stdout.write(
  `# HealthBridge ${args.env} environment (generated ${new Date().toISOString()}).\n` +
    '# SECRET: keep on the server (chmod 600) and in the secret manager only.\n' +
    Object.entries(values)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') +
    '\n',
);
