import { domainMetrics } from '../metrics/domain.js';
import { recordDeadLetter, failureReason } from './deadLetters.js';
import { outboxJobId, routesFor } from './routing.js';
import { addWithTimeout } from './queues.js';

const MAX_BACKOFF_MS = 5 * 60_000;

/**
 * Transactional outbox relay (ADR-0005, ADR-0020).
 *
 *   BEGIN
 *     SELECT … FROM outbox_events WHERE status = 'pending' AND available_at <= now()
 *       ORDER BY occurred_at LIMIT n FOR UPDATE SKIP LOCKED      -- claim a batch
 *     for each event: queue.add(type, ids, { jobId: consumer-eventId })   -- publish
 *                     UPDATE … SET status = 'dispatched'                    -- mark
 *   COMMIT
 *
 * - Several relays can run at once: SKIP LOCKED gives each a disjoint batch.
 * - A crash before COMMIT releases the claim and leaves the event pending: it is published
 *   again later (at-least-once). The deterministic job id makes the re-publish a no-op
 *   while BullMQ still holds the first job; consumers are idempotent beyond that.
 * - Redis down: publishing fails fast, the event stays pending with backoff (attempts,
 *   last_error, available_at); after OUTBOX_MAX_ATTEMPTS it is marked failed and
 *   dead-lettered. Events are never deleted by the relay.
 *
 * @param {{ knex: import('knex').Knex, queues: Record<string, import('bullmq').Queue>, logger?: import('pino').Logger,
 *   maxAttempts: number, pollIntervalMs: number, batchSize?: number, baseBackoffMs?: number, publishTimeoutMs?: number,
 *   hooks?: { afterPublish?: (event: object) => Promise<void> } }} deps
 */
export function createOutboxRelay({
  knex,
  queues,
  logger,
  maxAttempts,
  pollIntervalMs,
  batchSize = 100,
  baseBackoffMs = 1_000,
  publishTimeoutMs = 5_000,
  hooks = {},
}) {
  let timer = null;
  let running = null;
  let stopped = true;

  async function publish(event) {
    for (const consumer of routesFor(event.event_type)) {
      const queue = queues[consumer];
      if (!queue) throw new Error(`no queue for consumer ${consumer}`);
      await addWithTimeout(
        queue,
        event.event_type,
        {
          eventId: event.id,
          eventType: event.event_type,
          aggregateType: event.aggregate_type,
          aggregateId: event.aggregate_id,
          payload: event.payload,
          occurredAt: event.occurred_at,
          requestId: event.request_id,
        },
        { jobId: outboxJobId(consumer, event.id) },
        publishTimeoutMs,
      );
    }
  }

  /** Claims and relays one batch. @returns {Promise<{ dispatched: number, failed: number }>} */
  async function runOnce() {
    const end = domainMetrics.outboxRelayLatency.startTimer();
    let dispatched = 0;
    let failed = 0;
    try {
      await knex.transaction(async (trx) => {
        const events = await trx('outbox_events')
          .where({ status: 'pending' })
          .where('available_at', '<=', trx.fn.now())
          .orderBy('occurred_at')
          .limit(batchSize)
          .forUpdate()
          .skipLocked();
        for (const event of events) {
          try {
            await publish(event);
            await hooks.afterPublish?.(event); // test hook: simulate a crash here
            await trx('outbox_events')
              .where({ id: event.id })
              .update({
                status: 'dispatched',
                published_at: trx.fn.now(),
                attempts: event.attempts + 1,
                last_error: null,
              });
            dispatched += 1;
            domainMetrics.outboxDispatched.inc();
          } catch (err) {
            if (err?.simulatedCrash) throw err;
            failed += 1;
            const attempts = event.attempts + 1;
            const final = attempts >= maxAttempts;
            const delay = Math.min(baseBackoffMs * 2 ** (attempts - 1), MAX_BACKOFF_MS);
            await trx('outbox_events')
              .where({ id: event.id })
              .update({
                attempts,
                last_error: failureReason(err),
                status: final ? 'failed' : 'pending',
                available_at: trx.raw(`now() + make_interval(secs => ?)`, [delay / 1000]),
              });
            domainMetrics.outboxFailed.inc({ final: String(final) });
            if (final) {
              await recordDeadLetter(trx, {
                queue: 'outbox',
                jobId: event.id,
                jobName: event.event_type,
                attempts,
                error: err,
                data: {
                  eventId: event.id,
                  eventType: event.event_type,
                  aggregateType: event.aggregate_type,
                  aggregateId: event.aggregate_id,
                },
              });
              domainMetrics.jobsDeadLettered.inc({ queue: 'outbox' });
            }
            logger?.warn(
              {
                eventId: event.id,
                eventType: event.event_type,
                attempts,
                final,
                err: failureReason(err),
              },
              'outbox publish failed',
            );
          }
        }
      });
    } finally {
      end();
    }
    return { dispatched, failed };
  }

  function schedule(delay) {
    if (stopped) return;
    timer = setTimeout(async () => {
      running = runOnce().catch((err) => {
        logger?.error({ err: failureReason(err) }, 'outbox relay batch failed');
        return { dispatched: 0, failed: 0, error: true };
      });
      const result = await running;
      running = null;
      // Drain quickly while there is a backlog; otherwise poll at the normal interval.
      schedule(result.dispatched >= batchSize ? 0 : pollIntervalMs);
    }, delay);
  }

  return {
    runOnce,
    start() {
      if (!stopped) return;
      stopped = false;
      schedule(0);
    },
    /** Stops polling and waits for an in-flight batch to commit or roll back. */
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (running) await running;
    },
  };
}
