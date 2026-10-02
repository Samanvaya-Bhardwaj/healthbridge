import { loadConfig } from './config/index.js';
import { createLogger } from './core/logger/index.js';
import { createKnex } from './core/db/knex.js';
import { createRedis } from './core/cache/redis.js';
import { createMetrics, createMetricsApp } from './core/metrics/index.js';
import { createNoopMailer } from './core/mail/mailer.js';
import { createQueues, defaultJobOptions } from './core/queue/queues.js';
import { createOutboxRelay } from './core/queue/outboxRelay.js';
import { createWorkerRuntime } from './core/queue/workerRuntime.js';
import { failureReason } from './core/queue/deadLetters.js';
import { createContainer } from './container.js';
import { createJobProcessors, registerSchedules } from './workers/handlers.js';

const SHUTDOWN_GRACE_MS = 30_000;

/**
 * Background worker process (same image as the API, ADR-0020):
 *   - outbox relay (PostgreSQL → BullMQ)
 *   - BullMQ workers: notifications, payments, appointments (reminders), maintenance
 *   - periodic schedules: payment-hold expiry, reminder scheduling
 * Run several instances for availability: claims use SKIP LOCKED and jobs are idempotent.
 */
async function main() {
  const config = loadConfig();
  const logger = createLogger({
    level: config.logLevel,
    service: 'healthbridge-worker',
    appEnv: config.appEnv,
  });
  const knex = createKnex(config.db, 'healthbridge-worker');
  const redis = createRedis(config.redis, 'healthbridge-worker');
  redis.on('error', (err) => logger.warn({ err: failureReason(err) }, 'redis error'));
  await redis
    .connect()
    .catch((err) => logger.error({ err: failureReason(err) }, 'redis connect failed'));

  const queues = createQueues({
    redis: config.redis,
    prefix: config.workers.queuePrefix,
    jobOptions: defaultJobOptions(config.workers),
  });
  const container = createContainer({
    config,
    logger,
    knex,
    redis,
    mailer: createNoopMailer({ logger }),
    queues,
  });

  const relay = createOutboxRelay({
    knex,
    queues,
    logger,
    maxAttempts: config.workers.outboxMaxAttempts,
    pollIntervalMs: config.workers.outboxPollIntervalMs,
  });
  const runtime = createWorkerRuntime({
    redis: config.redis,
    prefix: config.workers.queuePrefix,
    knex,
    logger,
    processors: createJobProcessors(container, queues),
  });
  try {
    await registerSchedules(queues, config.workers);
  } catch (err) {
    // Redis down at startup: schedules are re-registered on the next start; the relay and
    // workers reconnect on their own.
    logger.error({ err: failureReason(err) }, 'could not register schedules');
  }
  relay.start();

  // Liveness marker in Redis (also lets integration tests refuse to run alongside a worker).
  const heartbeatKey = `${config.workers.queuePrefix}:worker:heartbeat:${process.pid}`;
  const beat = () => redis.set(heartbeatKey, new Date().toISOString(), 'EX', 30).catch(() => {});
  await beat();
  const heartbeat = setInterval(beat, 10_000);
  heartbeat.unref();

  let ready = true;
  const metrics = createMetrics({ service: 'healthbridge-worker' });
  const metricsServer = createMetricsApp(metrics.registry, (app) => {
    app.get('/health/live', (_req, res) =>
      res.status(ready ? 200 : 503).json({ status: ready ? 'ok' : 'stopping' }),
    );
  }).listen(config.workers.metricsPort, () =>
    logger.info({ port: config.workers.metricsPort }, 'worker metrics listening'),
  );
  logger.info({ provider: container.paymentProvider.name }, 'worker started');

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    ready = false;
    logger.info({ signal }, 'worker shutting down');
    const force = setTimeout(() => {
      logger.error('graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    force.unref();
    // 1. stop claiming outbox events (the in-flight batch commits or rolls back)
    clearInterval(heartbeat);
    await relay.stop();
    // 2–3. stop taking jobs; active jobs (and their transactions) run to completion
    await runtime.close();
    await queues.close();
    // 4–5. close Redis and the database
    await redis.del(heartbeatKey).catch(() => {});
    await Promise.allSettled([redis.quit(), knex.destroy()]);
    await new Promise((resolve) => metricsServer.close(resolve));
    logger.info('worker shutdown complete');
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: failureReason(reason) }, 'unhandled promise rejection');
    shutdown('unhandledRejection');
  });
}

main().catch((err) => {
  process.stderr.write(
    `${JSON.stringify({ level: 'fatal', msg: 'worker startup failed', error: err.message })}\n`,
  );
  process.exit(1);
});
