import { HeadBucketCommand } from '@aws-sdk/client-s3';

/**
 * @typedef {{ name: string, critical: boolean, check: () => Promise<void> }} HealthCheck
 * @typedef {{ status: 'up' | 'down', critical: boolean, latencyMs: number, error?: string }} CheckResult
 */

const DEFAULT_TIMEOUT_MS = 2_000;

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Runs all checks in parallel. The service is ready only when every critical
 * dependency is up; non-critical failures report as "degraded".
 * @param {HealthCheck[]} checks
 */
export async function runHealthChecks(checks, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const entries = await Promise.all(
    checks.map(async ({ name, critical, check }) => {
      const started = performance.now();
      try {
        await withTimeout(check(), timeoutMs);
        return [name, { status: 'up', critical, latencyMs: elapsed(started) }];
      } catch (err) {
        // Error class/message only: dependency errors can include hostnames but never PHI.
        const error = err?.name && err.name !== 'Error' ? err.name : (err?.message ?? 'error');
        return [name, { status: 'down', critical, latencyMs: elapsed(started), error }];
      }
    }),
  );
  const results = Object.fromEntries(entries);
  const values = Object.values(results);
  const criticalDown = values.some((r) => r.critical && r.status === 'down');
  const anyDown = values.some((r) => r.status === 'down');
  return {
    status: criticalDown ? 'unavailable' : anyDown ? 'degraded' : 'ok',
    checks: results,
  };
}

const elapsed = (started) => Math.round(performance.now() - started);

/** Builds the dependency checks for the running API. */
export function buildDependencyChecks({ knex, redis, s3, documentsBucket, aiClient }) {
  return [
    { name: 'database', critical: true, check: () => knex.raw('select 1') },
    {
      name: 'redis',
      critical: true,
      check: async () => {
        const reply = await redis.ping();
        if (reply !== 'PONG') throw new Error('unexpected PING reply');
      },
    },
    {
      name: 'objectStorage',
      critical: true,
      check: () => s3.send(new HeadBucketCommand({ Bucket: documentsBucket })),
    },
    // The AI service is required for AI features only; core care workflows
    // (booking, consultations, prescriptions) must keep working without it.
    { name: 'aiService', critical: false, check: () => aiClient.ping() },
  ];
}
