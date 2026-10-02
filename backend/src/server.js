import { createRequire } from 'node:module';
import { loadConfig } from './config/index.js';
import { createLogger } from './core/logger/index.js';
import { createKnex } from './core/db/knex.js';
import { createRedis } from './core/cache/redis.js';
import { createS3Client } from './core/storage/s3.js';
import { createAiClient } from './core/ai/client.js';
import { buildDependencyChecks } from './core/health/checks.js';
import { createMetrics, createMetricsApp } from './core/metrics/index.js';
import { createApp } from './app.js';
import { createContainer } from './container.js';
import { createNoopMailer, createSmtpMailer } from './core/mail/mailer.js';
import { assertPermissionCatalog } from './core/authz/catalogCheck.js';
import { createQueues, defaultJobOptions } from './core/queue/queues.js';

const { version } = createRequire(import.meta.url)('../package.json');
const SHUTDOWN_GRACE_MS = 10_000;

async function main() {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, appEnv: config.appEnv });

  const knex = createKnex(config.db);
  const redis = createRedis(config.redis);
  const s3 = createS3Client(config.storage);
  const aiClient = createAiClient(config.aiService);
  const metrics = createMetrics();

  redis.on('error', (err) =>
    logger.warn({ err: { name: err.name, message: err.message } }, 'redis error'),
  );
  await redis.connect().catch((err) => {
    // Start anyway: readiness reports Redis as down until it recovers.
    logger.error({ err: { name: err.name, message: err.message } }, 'redis initial connect failed');
  });

  const healthChecks = buildDependencyChecks({
    knex,
    redis,
    s3,
    documentsBucket: config.storage.documentsBucket,
    aiClient,
  });

  const mailer = config.mail.smtpHost
    ? createSmtpMailer({ ...config.mail, logger })
    : createNoopMailer({ logger });
  // Producers only (dead-letter retries); jobs are processed by the worker process.
  const queues = createQueues({
    redis: config.redis,
    prefix: config.workers.queuePrefix,
    jobOptions: defaultJobOptions(config.workers),
  });
  const container = createContainer({ config, logger, knex, redis, mailer, queues });

  // Fail fast if the database RBAC catalog drifted from the code contract.
  await assertPermissionCatalog(container.repositories.roles);

  const app = createApp({ config, logger, healthChecks, redis, metrics, container, version });
  const server = app.listen(config.http.port, () => {
    logger.info(
      { port: config.http.port, appEnv: config.appEnv, demoMode: config.demoMode },
      'api listening',
    );
  });
  server.keepAliveTimeout = 65_000; // above typical load balancer idle timeouts
  server.headersTimeout = 66_000;

  const metricsServer = createMetricsApp(metrics.registry).listen(config.http.metricsPort, () => {
    logger.info({ port: config.http.metricsPort }, 'metrics listening');
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => {
      logger.error('graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    force.unref();

    await Promise.allSettled([
      new Promise((resolve) => server.close(resolve)),
      new Promise((resolve) => metricsServer.close(resolve)),
    ]);
    await Promise.allSettled([knex.destroy(), redis.quit(), queues.close()]);
    s3.destroy();
    logger.info('shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled promise rejection');
    shutdown('unhandledRejection');
  });
}

main().catch((err) => {
  // Logger may not exist yet (e.g. invalid configuration); write a minimal JSON line.
  process.stderr.write(
    `${JSON.stringify({ level: 'fatal', msg: 'startup failed', error: err.message })}\n`,
  );
  process.exit(1);
});
