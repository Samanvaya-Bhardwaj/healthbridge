import { UnrecoverableError, Worker } from 'bullmq';
import { AppError } from '../http/errors.js';
import { domainMetrics } from '../metrics/domain.js';
import { bullConnection } from './queues.js';
import { failureReason, recordDeadLetter } from './deadLetters.js';

/**
 * Errors that a retry cannot fix: client-type application errors (4xx), invalid job data
 * and errors explicitly marked permanent. Everything else (timeouts, provider 5xx,
 * database or Redis outages) is retried with exponential backoff up to the job's limit.
 */
export function isPermanent(err) {
  if (err instanceof UnrecoverableError) return true;
  if (err instanceof AppError && err.status < 500) return true;
  if (err?.retryable === false) return true;
  return false;
}

/**
 * Runs BullMQ workers for the given processors.
 *
 * @param {{
 *   redis: object, prefix: string, knex: import('knex').Knex, logger?: import('pino').Logger,
 *   processors: Record<string, { concurrency?: number, schemas?: Record<string, import('zod').ZodType>, handle: (job: import('bullmq').Job) => Promise<unknown> }>,
 * }} options
 */
export function createWorkerRuntime({ redis, prefix, knex, logger, processors }) {
  const connection = bullConnection(redis, { worker: true });

  const workers = Object.entries(processors).map(
    ([queue, { concurrency = 4, schemas = {}, handle }]) => {
      const worker = new Worker(
        queue,
        async (job) => {
          const end = domainMetrics.jobLatency.startTimer({ queue });
          try {
            const schema = schemas[job.name] ?? schemas['*'];
            if (!schema || !schema.safeParse(job.data).success) {
              throw new UnrecoverableError(`invalid or unknown job ${job.name}`);
            }
            const result = await handle(job);
            end({ outcome: 'success' });
            return result ?? null;
          } catch (err) {
            end({ outcome: 'failure' });
            const permanent = isPermanent(err);
            const attempts = job.opts.attempts ?? 1;
            const final = permanent || job.attemptsMade + 1 >= attempts;
            domainMetrics.jobsFailed.inc({ queue });
            if (queue === 'documents') domainMetrics.documentWorkerFailures.inc();
            logger?.warn(
              {
                queue,
                jobId: job.id,
                jobName: job.name,
                attempt: job.attemptsMade + 1,
                final,
                err: failureReason(err),
              },
              'job failed',
            );
            if (final) {
              // Durable dead letter before BullMQ marks the job failed.
              await recordDeadLetter(knex, {
                queue,
                jobId: job.id,
                jobName: job.name,
                attempts: job.attemptsMade + 1,
                error: err,
                data: job.data,
                firstFailedAt: job.processedOn ? new Date(job.processedOn) : null,
              }).catch((dlqErr) =>
                logger?.error(
                  { queue, jobId: job.id, err: failureReason(dlqErr) },
                  'dead-letter write failed',
                ),
              );
              domainMetrics.jobsDeadLettered.inc({ queue });
              if (queue === 'documents') domainMetrics.documentWorkerDlq.inc();
              if (permanent && !(err instanceof UnrecoverableError)) {
                throw new UnrecoverableError(failureReason(err));
              }
            } else {
              domainMetrics.jobsRetried.inc({ queue });
              if (queue === 'documents') domainMetrics.documentWorkerRetries.inc();
            }
            throw err;
          }
        },
        { connection, prefix, concurrency, autorun: true },
      );
      worker.on('completed', () => domainMetrics.jobsProcessed.inc({ queue }));
      worker.on('error', (err) => logger?.warn({ queue, err: failureReason(err) }, 'worker error'));
      return worker;
    },
  );

  return {
    workers,
    /** Stops taking jobs and waits for active jobs to finish (never cut mid-transaction). */
    async close() {
      await Promise.allSettled(workers.map((w) => w.close()));
    },
  };
}
