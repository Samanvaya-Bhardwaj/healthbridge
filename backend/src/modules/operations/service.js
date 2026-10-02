import { isUuid } from '../../core/db/ids.js';
import { ConflictError, NotFoundError, ServiceUnavailableError } from '../../core/http/errors.js';
import { ALL_QUEUES, addWithTimeout } from '../../core/queue/queues.js';

const toDeadLetterView = (row) => ({
  id: row.id,
  queue: row.queue,
  jobId: row.job_id,
  jobName: row.job_name,
  attempts: row.attempts,
  failureReason: row.failure_reason,
  aggregateType: row.aggregate_type,
  aggregateId: row.aggregate_id,
  sourceEventId: row.source_event_id,
  status: row.status,
  firstFailedAt: row.first_failed_at,
  failedAt: row.failed_at,
  retriedAt: row.retried_at,
});

/**
 * Background-job operations for platform administrators (operations:manage). Exposes
 * identifiers, counts and failure reasons only — never payloads with patient content
 * (there are none by construction) or financial details.
 */
export function createOperationsService({ knex, audit, queues }) {
  async function listDeadLetters({ status = 'open', limit = 50 }) {
    const rows = await knex('dead_letter_jobs')
      .where({ status })
      .orderBy('failed_at', 'desc')
      .limit(limit);
    return rows.map(toDeadLetterView);
  }

  async function summary() {
    const [outbox, deadLetters] = await Promise.all([
      knex('outbox_events').select('status').count({ count: '*' }).groupBy('status'),
      knex('dead_letter_jobs').select('status').count({ count: '*' }).groupBy('status'),
    ]);
    const counts = (rows) => Object.fromEntries(rows.map((r) => [r.status, Number(r.count)]));
    let queueCounts = null;
    if (queues) {
      let timer;
      try {
        // Bounded: an unreachable Redis must not hang the operations page.
        queueCounts = Object.fromEntries(
          await Promise.race([
            Promise.all(
              ALL_QUEUES.map(async (name) => [
                name,
                await queues[name].getJobCounts(
                  'waiting',
                  'active',
                  'delayed',
                  'failed',
                  'completed',
                ),
              ]),
            ),
            new Promise((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error('queue counts timed out')), 2_000);
            }),
          ]),
        );
      } catch {
        queueCounts = null; // Redis unavailable: report what PostgreSQL knows
      } finally {
        clearTimeout(timer);
      }
    }
    return { outbox: counts(outbox), deadLetters: counts(deadLetters), queues: queueCounts };
  }

  /** Re-queues a dead-lettered job (or re-opens a failed outbox event). Audited. */
  async function retryDeadLetter(principal, id, req) {
    if (!isUuid(id)) throw new NotFoundError();
    const row = await knex('dead_letter_jobs').where({ id }).first();
    if (!row) throw new NotFoundError();
    if (row.status !== 'open')
      throw new ConflictError('This job was already retried.', 'already_retried');

    if (row.queue === 'outbox') {
      await knex('outbox_events')
        .where({ id: row.job_id, status: 'failed' })
        .update({ status: 'pending', attempts: 0, available_at: knex.fn.now(), last_error: null });
    } else {
      if (!queues?.[row.queue]) throw new ServiceUnavailableError('The job queue is unavailable.');
      // A new job id: the original failed job may still be retained in Redis. Consumers
      // are idempotent, so a retry never repeats an effect that already happened.
      await addWithTimeout(queues[row.queue], row.job_name, row.data, {
        jobId: `${row.job_id}-retry-${Date.now()}`,
      });
    }
    await knex('dead_letter_jobs').where({ id }).update({
      status: 'retried',
      retried_at: knex.fn.now(),
      retried_by_user_id: principal.userId,
    });
    await audit.record(
      {
        category: 'administration',
        action: 'operations.dead_letter_retry',
        outcome: 'success',
        resourceType: 'dead_letter_job',
        resourceId: id,
        metadata: { queue: row.queue, jobName: row.job_name },
      },
      { req },
    );
    return toDeadLetterView({ ...row, status: 'retried', retried_at: new Date() });
  }

  return { listDeadLetters, summary, retryDeadLetter };
}
