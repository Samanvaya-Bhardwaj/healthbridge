import { newId } from '../db/ids.js';

const MAX_REASON = 500;

/** Failure reason without stack traces or payloads: error class/kind and message only. */
export function failureReason(err) {
  const kind = err?.kind ? `[${err.kind}] ` : '';
  const code = err?.code && typeof err.code === 'string' ? ` (${err.code})` : '';
  return `${err?.name ?? 'Error'}: ${kind}${err?.message ?? 'unknown failure'}${code}`.slice(
    0,
    MAX_REASON,
  );
}

/**
 * Job data holds identifiers and short non-sensitive attributes by construction (outbox
 * payload rules). Keep only known keys and short scalars, so a retry can rebuild the job.
 */
function safeData(data = {}) {
  const keep = ['eventId', 'eventType', 'aggregateType', 'aggregateId', 'reminderId'];
  const out = Object.fromEntries(
    keep.filter((k) => data[k] !== undefined).map((k) => [k, data[k]]),
  );
  if (data.payload && typeof data.payload === 'object') {
    out.payload = Object.fromEntries(
      Object.entries(data.payload)
        .slice(0, 20)
        .filter(
          ([, v]) =>
            v === null ||
            typeof v === 'number' ||
            typeof v === 'boolean' ||
            (typeof v === 'string' && v.length <= 100),
        ),
    );
  }
  return out;
}

/**
 * Records a job that exhausted its retries (or failed permanently) in PostgreSQL, where it
 * survives Redis and can be inspected and retried by operations staff.
 */
export async function recordDeadLetter(
  knex,
  { queue, jobId, jobName, attempts, error, data, firstFailedAt },
) {
  const row = {
    id: newId(),
    queue,
    job_id: String(jobId),
    job_name: jobName,
    attempts,
    failure_reason: failureReason(error),
    data: safeData(data),
    aggregate_type: data?.aggregateType ?? null,
    aggregate_id: /^[0-9a-f-]{36}$/.test(data?.aggregateId ?? '') ? data.aggregateId : null,
    source_event_id: /^[0-9a-f-]{36}$/.test(data?.eventId ?? '') ? data.eventId : null,
    first_failed_at: firstFailedAt ?? null,
    status: 'open',
  };
  await knex('dead_letter_jobs').insert(row).onConflict(['queue', 'job_id']).merge({
    attempts: row.attempts,
    failure_reason: row.failure_reason,
    failed_at: knex.fn.now(),
    status: 'open',
  });
}
