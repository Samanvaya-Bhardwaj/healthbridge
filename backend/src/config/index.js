import { createPrivateKey, createPublicKey } from 'node:crypto';
import { z } from 'zod';

const port = z.coerce.number().int().min(1).max(65535);
const positiveInt = z.coerce.number().int().positive();
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

    SMTP_HOST: z.string().min(1).optional(),
    SMTP_PORT: port.default(1025),
    MAIL_FROM: z.string().min(3).default('HealthBridge <no-reply@healthbridge.local>'),

    AI_SERVICE_URL: z.url(),
    INTERNAL_SERVICE_SECRET: z.string().min(32, 'must be at least 32 characters'),

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
    },
    mail: { smtpHost: e.SMTP_HOST, smtpPort: e.SMTP_PORT, from: e.MAIL_FROM },
    aiService: { url: e.AI_SERVICE_URL, internalSecret: e.INTERNAL_SERVICE_SECRET },
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
