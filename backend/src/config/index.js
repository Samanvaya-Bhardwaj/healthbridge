import { z } from 'zod';

const port = z.coerce.number().int().min(1).max(65535);
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

    AI_SERVICE_URL: z.url(),
    INTERNAL_SERVICE_SECRET: z.string().min(32, 'must be at least 32 characters'),
  })
  .superRefine((env, ctx) => {
    if (env.APP_ENV === 'production' && env.DEMO_MODE) {
      ctx.addIssue({
        code: 'custom',
        path: ['DEMO_MODE'],
        message: 'demo mode cannot be enabled when APP_ENV=production',
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

/**
 * Parse and validate environment variables into a frozen, structured config object.
 * @param {Record<string, string | undefined>} [env]
 */
export function loadConfig(env = process.env) {
  const result = envSchema.safeParse(env);
  if (!result.success) throw new ConfigError(result.error.issues);
  const e = result.data;

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
    aiService: { url: e.AI_SERVICE_URL, internalSecret: e.INTERNAL_SERVICE_SECRET },
  });
}

function deepFreeze(object) {
  for (const value of Object.values(object)) {
    if (value && typeof value === 'object') deepFreeze(value);
  }
  return Object.freeze(object);
}
