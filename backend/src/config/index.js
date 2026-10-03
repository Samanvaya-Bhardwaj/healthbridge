import { createPrivateKey, createPublicKey, hkdfSync, randomBytes } from 'node:crypto';
import { z } from 'zod';

const port = z.coerce.number().int().min(1).max(65535);
const positiveInt = z.coerce.number().int().positive();
/** Compose passes unset optional variables as empty strings: treat them as absent. */
const optional = (schema) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
const csv = z.string().transform((value) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
);

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    DEMO_MODE: z.stringbool().default(false),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    API_PORT: port.default(4000),
    METRICS_PORT: port.default(9464),
    CORS_ORIGINS: csv.default([]),
    TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),

    DB_HOST: z.string().min(1),
    DB_PORT: port.default(5432),
    POSTGRES_DB: z.string().min(1),
    DB_APP_USER: z.string().min(1),
    DB_APP_PASSWORD: z.string().min(1),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

    REDIS_HOST: z.string().min(1),
    REDIS_PORT: port.default(6379),
    REDIS_PASSWORD: z.string().min(1),

    S3_ENDPOINT: z.url().optional(),
    S3_REGION: z.string().min(1),
    S3_ACCESS_KEY_ID: z.string().min(1),
    S3_SECRET_ACCESS_KEY: z.string().min(1),
    S3_BUCKET_DOCUMENTS: z.string().min(3),
    S3_FORCE_PATH_STYLE: z.stringbool().default(false),
    // Endpoint browsers use for presigned uploads/downloads (e.g. the Nginx origin); the
    // API itself talks to S3_ENDPOINT. Defaults to S3_ENDPOINT.
    S3_PUBLIC_ENDPOINT: optional(z.url()),

    // ── Medical documents (ADR-0021) ──
    // fake = deterministic test scanner (NOT malware protection); clamav = clamd INSTREAM.
    DOCUMENT_SCANNER: z.enum(['fake', 'clamav']).default('fake'),
    CLAMAV_HOST: optional(z.string().min(1)),
    CLAMAV_PORT: port.default(3310),
    DOCUMENT_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1024)
      .max(25 * 1024 * 1024)
      .default(10 * 1024 * 1024),
    DOCUMENT_UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(300),
    DOCUMENT_DOWNLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(1).max(300).default(60),

    SMTP_HOST: z.string().min(1).optional(),
    SMTP_PORT: port.default(1025),
    MAIL_FROM: z.string().min(3).default('HealthBridge <no-reply@healthbridge.local>'),

    AI_SERVICE_URL: z.url(),
    INTERNAL_SERVICE_SECRET: z.string().min(32, 'must be at least 32 characters'),

    // ── Consultations (ADR-0025) ──
    VIDEO_PROVIDER: z.enum(['mock', 'livekit']).default('mock'),
    LIVEKIT_URL: optional(z.url()),
    LIVEKIT_API_KEY: optional(z.string().min(3)),
    LIVEKIT_API_SECRET: optional(z.string().min(32, 'must be at least 32 characters')),
    VIDEO_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(600),
    // AES-256 key (base64, 32 bytes) that wraps per-record data keys of clinical notes.
    // Required outside development/test; there a key is derived from INTERNAL_SERVICE_SECRET.
    CLINICAL_DATA_KEY: optional(z.base64()),
    CLINICAL_DATA_KEY_ID: z
      .string()
      .regex(/^[a-z0-9_-]{1,32}$/)
      .default('k1'),
    // Previous keys during rotation: "keyId:base64,keyId:base64".
    CLINICAL_DATA_PREVIOUS_KEYS: csv.default([]),

    // ── Authentication (ADR-0015) ──
    // Ed25519 private key, PKCS#8 PEM, base64-encoded onto one line.
    AUTH_JWT_PRIVATE_KEY: z.string().min(1),
    // Optional previous public keys (SPKI PEM, base64, comma-separated) during rotation.
    AUTH_JWT_PREVIOUS_PUBLIC_KEYS: csv.default([]),
    AUTH_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(600),
    SESSION_IDLE_TTL_MINUTES: positiveInt.default(4320), // 3 days
    SESSION_ABSOLUTE_TTL_HOURS: positiveInt.default(336), // 14 days
    PRIVILEGED_SESSION_IDLE_TTL_MINUTES: positiveInt.default(720), // 12 hours
    PRIVILEGED_SESSION_ABSOLUTE_TTL_HOURS: positiveInt.default(72), // 3 days
    AUTH_COOKIE_SECURE: z.stringbool().default(true),

    // ── Payments (ADR-0020) ──
    PAYMENT_PROVIDER: z.enum(['fake', 'razorpay']).default('fake'),
    // HMAC secret for provider webhooks (Razorpay dashboard secret, or the fake provider's).
    PAYMENT_WEBHOOK_SECRET: optional(z.string().min(16, 'must be at least 16 characters')),
    RAZORPAY_KEY_ID: optional(
      z.string().regex(/^rzp_(test|live)_[A-Za-z0-9]+$/, 'must be a Razorpay key id'),
    ),
    RAZORPAY_KEY_SECRET: optional(z.string().min(8)),
    PAYMENT_PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),

    // ── Notifications ──
    NOTIFICATION_EMAIL_PROVIDER: z.enum(['fake', 'smtp']).default('fake'),
    // Minutes before the start; e.g. "1440,60" = 24-hour and 1-hour reminders.
    REMINDER_OFFSETS_MINUTES: csv
      .pipe(z.array(z.coerce.number().int().min(5).max(10080)).max(5))
      .default([1440, 60]),

    // ── Workers ──
    WORKER_METRICS_PORT: port.default(9465),
    QUEUE_PREFIX: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,30}$/)
      .default('hb'),
    JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(6),
    JOB_BACKOFF_MS: z.coerce.number().int().min(10).max(600_000).default(5_000),
    OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(50).max(60_000).default(1_000),
    OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(20),
    HOLD_SWEEP_INTERVAL_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),
    REMINDER_SWEEP_INTERVAL_MS: z.coerce.number().int().min(1_000).max(600_000).default(60_000),
  })
  .superRefine((env, ctx) => {
    if (env.APP_ENV === 'production' && env.DEMO_MODE) {
      ctx.addIssue({
        code: 'custom',
        path: ['DEMO_MODE'],
        message: 'demo mode cannot be enabled when APP_ENV=production',
      });
    }
    if (['staging', 'production'].includes(env.APP_ENV) && !env.AUTH_COOKIE_SECURE) {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_COOKIE_SECURE'],
        message: 'secure cookies are required outside development/test',
      });
    }
    // Payments: no fake provider in production; no live keys (real money) elsewhere.
    if (env.APP_ENV === 'production' && env.PAYMENT_PROVIDER === 'fake') {
      ctx.addIssue({
        code: 'custom',
        path: ['PAYMENT_PROVIDER'],
        message: 'the fake payment provider cannot be used when APP_ENV=production',
      });
    }
    if (env.PAYMENT_PROVIDER === 'razorpay') {
      for (const name of ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'PAYMENT_WEBHOOK_SECRET']) {
        if (!env[name]) {
          ctx.addIssue({ code: 'custom', path: [name], message: 'required for razorpay' });
        }
      }
      const live = env.RAZORPAY_KEY_ID?.startsWith('rzp_live_');
      if (env.APP_ENV === 'production' && env.RAZORPAY_KEY_ID && !live) {
        ctx.addIssue({
          code: 'custom',
          path: ['RAZORPAY_KEY_ID'],
          message: 'production requires a live key',
        });
      }
      if (env.APP_ENV !== 'production' && live) {
        ctx.addIssue({
          code: 'custom',
          path: ['RAZORPAY_KEY_ID'],
          message: 'live keys are allowed only when APP_ENV=production',
        });
      }
    }
    // Documents: never mark files clean without a real scanner outside dev/test.
    if (['staging', 'production'].includes(env.APP_ENV) && env.DOCUMENT_SCANNER === 'fake') {
      ctx.addIssue({
        code: 'custom',
        path: ['DOCUMENT_SCANNER'],
        message: 'the fake document scanner provides no malware protection; use clamav',
      });
    }
    if (env.DOCUMENT_SCANNER === 'clamav' && !env.CLAMAV_HOST) {
      ctx.addIssue({ code: 'custom', path: ['CLAMAV_HOST'], message: 'required for clamav' });
    }
    if (env.APP_ENV === 'production' && env.NOTIFICATION_EMAIL_PROVIDER === 'fake') {
      ctx.addIssue({
        code: 'custom',
        path: ['NOTIFICATION_EMAIL_PROVIDER'],
        message: 'the fake notification provider cannot be used when APP_ENV=production',
      });
    }
    if (env.NOTIFICATION_EMAIL_PROVIDER === 'smtp' && !env.SMTP_HOST) {
      ctx.addIssue({ code: 'custom', path: ['SMTP_HOST'], message: 'required for smtp' });
    }
    if (['staging', 'production'].includes(env.APP_ENV) && !env.CLINICAL_DATA_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['CLINICAL_DATA_KEY'],
        message: 'a dedicated clinical data key is required outside development/test',
      });
    }
    if (env.CLINICAL_DATA_KEY && Buffer.from(env.CLINICAL_DATA_KEY, 'base64').length !== 32) {
      ctx.addIssue({ code: 'custom', path: ['CLINICAL_DATA_KEY'], message: 'must be 32 bytes' });
    }
    if (env.APP_ENV === 'production' && env.VIDEO_PROVIDER === 'mock') {
      ctx.addIssue({
        code: 'custom',
        path: ['VIDEO_PROVIDER'],
        message: 'the mock video provider cannot be used when APP_ENV=production',
      });
    }
    if (env.VIDEO_PROVIDER === 'livekit') {
      for (const name of ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET']) {
        if (!env[name]) {
          ctx.addIssue({ code: 'custom', path: [name], message: 'required for livekit' });
        }
      }
    }
    if (env.SESSION_IDLE_TTL_MINUTES > env.SESSION_ABSOLUTE_TTL_HOURS * 60) {
      ctx.addIssue({
        code: 'custom',
        path: ['SESSION_IDLE_TTL_MINUTES'],
        message: 'idle TTL must not exceed absolute TTL',
      });
    }
    if (env.PRIVILEGED_SESSION_IDLE_TTL_MINUTES > env.PRIVILEGED_SESSION_ABSOLUTE_TTL_HOURS * 60) {
      ctx.addIssue({
        code: 'custom',
        path: ['PRIVILEGED_SESSION_IDLE_TTL_MINUTES'],
        message: 'privileged idle TTL must not exceed privileged absolute TTL',
      });
    }
  });

export class ConfigError extends Error {
  constructor(issues) {
    // Report variable names and rule violations only, never values.
    const details = issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    super(`Invalid environment configuration: ${details}`);
    this.name = 'ConfigError';
    this.issues = issues.map((i) => ({ variable: i.path.join('.'), message: i.message }));
  }
}

const decodePem = (base64) => Buffer.from(base64, 'base64').toString('utf8');

function loadClinicalKeys(env) {
  const current = env.CLINICAL_DATA_KEY
    ? Buffer.from(env.CLINICAL_DATA_KEY, 'base64')
    : Buffer.from(
        hkdfSync(
          'sha256',
          env.INTERNAL_SERVICE_SECRET,
          'healthbridge',
          'clinical-data-dev-key',
          32,
        ),
      );
  const keys = new Map([[env.CLINICAL_DATA_KEY_ID, current]]);
  for (const entry of env.CLINICAL_DATA_PREVIOUS_KEYS) {
    const [id, value] = entry.split(':');
    const key = Buffer.from(value ?? '', 'base64');
    if (!/^[a-z0-9_-]{1,32}$/.test(id ?? '') || key.length !== 32 || keys.has(id)) {
      throw new ConfigError([
        {
          path: ['CLINICAL_DATA_PREVIOUS_KEYS'],
          message: 'entries must be keyId:base64(32 bytes)',
        },
      ]);
    }
    keys.set(id, key);
  }
  return { currentKeyId: env.CLINICAL_DATA_KEY_ID, keys };
}

function loadSigningKeys(env) {
  try {
    const privateKey = createPrivateKey(decodePem(env.AUTH_JWT_PRIVATE_KEY));
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('not an Ed25519 key');
    const previousPublicKeys = env.AUTH_JWT_PREVIOUS_PUBLIC_KEYS.map((k) =>
      createPublicKey(decodePem(k)),
    );
    return { privateKey, publicKey: createPublicKey(privateKey), previousPublicKeys };
  } catch {
    throw new ConfigError([
      {
        path: ['AUTH_JWT_PRIVATE_KEY'],
        message: 'must be a base64-encoded Ed25519 PKCS#8 PEM private key',
      },
    ]);
  }
}

/**
 * Parse and validate environment variables into a frozen, structured config object.
 * @param {Record<string, string | undefined>} [env]
 */
export function loadConfig(env = process.env) {
  const result = envSchema.safeParse(env);
  if (!result.success) throw new ConfigError(result.error.issues);
  const e = result.data;
  const keys = loadSigningKeys(e);
  // Development/test without a configured secret: a per-process random secret keeps the
  // fake provider's webhooks verifiable without ever committing one.
  const webhookSecret = e.PAYMENT_WEBHOOK_SECRET ?? randomBytes(32).toString('hex');

  return deepFreeze({
    nodeEnv: e.NODE_ENV,
    appEnv: e.APP_ENV,
    isProduction: e.APP_ENV === 'production',
    demoMode: e.DEMO_MODE,
    logLevel: e.LOG_LEVEL,
    http: {
      port: e.API_PORT,
      metricsPort: e.METRICS_PORT,
      corsOrigins: e.CORS_ORIGINS,
      trustProxy: e.TRUST_PROXY,
    },
    db: {
      host: e.DB_HOST,
      port: e.DB_PORT,
      database: e.POSTGRES_DB,
      user: e.DB_APP_USER,
      password: e.DB_APP_PASSWORD,
      poolMax: e.DB_POOL_MAX,
    },
    redis: { host: e.REDIS_HOST, port: e.REDIS_PORT, password: e.REDIS_PASSWORD },
    storage: {
      endpoint: e.S3_ENDPOINT,
      region: e.S3_REGION,
      accessKeyId: e.S3_ACCESS_KEY_ID,
      secretAccessKey: e.S3_SECRET_ACCESS_KEY,
      documentsBucket: e.S3_BUCKET_DOCUMENTS,
      forcePathStyle: e.S3_FORCE_PATH_STYLE,
      publicEndpoint: e.S3_PUBLIC_ENDPOINT ?? e.S3_ENDPOINT,
    },
    documents: {
      scanner: e.DOCUMENT_SCANNER,
      clamav: { host: e.CLAMAV_HOST, port: e.CLAMAV_PORT },
      maxBytes: e.DOCUMENT_MAX_BYTES,
      uploadUrlTtlSeconds: e.DOCUMENT_UPLOAD_URL_TTL_SECONDS,
      downloadUrlTtlSeconds: e.DOCUMENT_DOWNLOAD_URL_TTL_SECONDS,
    },
    mail: { smtpHost: e.SMTP_HOST, smtpPort: e.SMTP_PORT, from: e.MAIL_FROM },
    payments: {
      provider: e.PAYMENT_PROVIDER,
      webhookSecret,
      timeoutMs: e.PAYMENT_PROVIDER_TIMEOUT_MS,
      razorpay: { keyId: e.RAZORPAY_KEY_ID, keySecret: e.RAZORPAY_KEY_SECRET },
      // The simulated checkout exists only with the fake provider outside production.
      simulationEnabled: e.PAYMENT_PROVIDER === 'fake' && e.APP_ENV !== 'production',
    },
    notifications: {
      emailProvider: e.NOTIFICATION_EMAIL_PROVIDER,
      reminderOffsetsMinutes: [...new Set(e.REMINDER_OFFSETS_MINUTES)].sort((a, b) => b - a),
    },
    workers: {
      metricsPort: e.WORKER_METRICS_PORT,
      queuePrefix: e.QUEUE_PREFIX,
      maxAttempts: e.JOB_MAX_ATTEMPTS,
      backoffMs: e.JOB_BACKOFF_MS,
      outboxPollIntervalMs: e.OUTBOX_POLL_INTERVAL_MS,
      outboxMaxAttempts: e.OUTBOX_MAX_ATTEMPTS,
      holdSweepIntervalMs: e.HOLD_SWEEP_INTERVAL_MS,
      reminderSweepIntervalMs: e.REMINDER_SWEEP_INTERVAL_MS,
    },
    aiService: { url: e.AI_SERVICE_URL, internalSecret: e.INTERNAL_SERVICE_SECRET },
    video: {
      provider: e.VIDEO_PROVIDER,
      tokenTtlSeconds: e.VIDEO_TOKEN_TTL_SECONDS,
      livekit: { url: e.LIVEKIT_URL, apiKey: e.LIVEKIT_API_KEY, apiSecret: e.LIVEKIT_API_SECRET },
      // The mock provider signs its room tokens with a key derived from the internal secret.
      mockSecret: e.INTERNAL_SERVICE_SECRET,
    },
    // Map of Buffers (not frozen by deepFreeze).
    clinicalData: loadClinicalKeys(e),
    auth: {
      // KeyObjects are not frozen (deepFreeze skips non-plain objects).
      signingKeys: keys,
      issuer: 'healthbridge-api',
      audience: 'healthbridge-app',
      accessTokenTtlSeconds: e.AUTH_ACCESS_TOKEN_TTL_SECONDS,
      session: {
        standard: {
          idleSeconds: e.SESSION_IDLE_TTL_MINUTES * 60,
          absoluteSeconds: e.SESSION_ABSOLUTE_TTL_HOURS * 3600,
        },
        privileged: {
          idleSeconds: e.PRIVILEGED_SESSION_IDLE_TTL_MINUTES * 60,
          absoluteSeconds: e.PRIVILEGED_SESSION_ABSOLUTE_TTL_HOURS * 3600,
        },
      },
      cookieSecure: e.AUTH_COOKIE_SECURE,
    },
  });
}

function deepFreeze(object) {
  for (const value of Object.values(object)) {
    if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      deepFreeze(value);
    } else if (Array.isArray(value)) {
      Object.freeze(value);
    }
  }
  return Object.freeze(object);
}
