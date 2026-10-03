import { Queue } from 'bullmq';

/**
 * BullMQ queues (ADR-0020). Four, by kind of work:
 *   notifications  outbox events that notify people
 *   payments       outbox events with financial effects (close/refund)
 *   appointments   appointment reminders
 *   maintenance    periodic sweeps (payment-hold expiry, reminders, consent expiry)
 *   documents      medical-document scanning, promotion and AI analysis (M5, M6)
 *   timeline       medical timeline projection (M7)
 * Redis is a delivery mechanism, never the source of truth: every job can be rebuilt
 * from PostgreSQL (outbox rows, reminder rows, holds).
 */
export const QUEUE_NAMES = Object.freeze({
  NOTIFICATIONS: 'notifications',
  PAYMENTS: 'payments',
  APPOINTMENTS: 'appointments',
  MAINTENANCE: 'maintenance',
  DOCUMENTS: 'documents',
  TIMELINE: 'timeline',
  FOLLOWUPS: 'followups',
});
export const ALL_QUEUES = Object.freeze(Object.values(QUEUE_NAMES));

/**
 * Connection options. Producers fail fast when Redis is down (the outbox keeps the event
 * and retries); workers use blocking connections that BullMQ requires to retry forever.
 * @param {{ host: string, port: number, password: string }} redis
 */
export function bullConnection(redis, { worker = false } = {}) {
  return {
    host: redis.host,
    port: redis.port,
    password: redis.password,
    ...(redis.tls ? { tls: { servername: redis.host } } : {}),
    connectTimeout: 3_000,
    retryStrategy: (attempt) => Math.min(attempt * 500, 5_000),
    ...(worker
      ? { maxRetriesPerRequest: null }
      : { maxRetriesPerRequest: 1, enableOfflineQueue: false }),
  };
}

/** Bounded retries with exponential backoff; finished jobs are pruned. */
export function defaultJobOptions({ maxAttempts, backoffMs }) {
  return {
    attempts: maxAttempts,
    backoff: { type: 'exponential', delay: backoffMs },
    // Completed job ids are kept for a day so re-publishing the same id is a no-op.
    removeOnComplete: { age: 24 * 3600, count: 10_000 },
    // Failed jobs are also recorded durably in dead_letter_jobs (PostgreSQL).
    removeOnFail: { age: 7 * 24 * 3600, count: 10_000 },
  };
}

/**
 * @param {{ redis: object, prefix: string, jobOptions: object }} options
 * @returns {Record<string, Queue> & { close: () => Promise<void> }}
 */
export function createQueues({ redis, prefix, jobOptions }) {
  const connection = bullConnection(redis);
  const queues = Object.fromEntries(
    ALL_QUEUES.map((name) => [
      name,
      new Queue(name, { connection, prefix, defaultJobOptions: jobOptions }),
    ]),
  );
  for (const queue of Object.values(queues)) {
    // Connection errors surface on add(); avoid unhandled 'error' events.
    queue.on('error', () => {});
  }
  return {
    ...queues,
    async close() {
      await Promise.allSettled(Object.values(queues).map((q) => q.close()));
    },
  };
}

export class QueuePublishTimeoutError extends Error {
  constructor(queue, ms) {
    super(`publishing to ${queue} timed out after ${ms} ms`);
    this.name = 'QueuePublishTimeoutError';
    this.kind = 'unavailable';
  }
}

/**
 * queue.add with a deadline. BullMQ waits indefinitely for an unreachable Redis; a bounded
 * publish lets the caller keep the work in PostgreSQL and retry later. If the add lands
 * after the deadline anyway, the deterministic job id makes the later re-publish a no-op.
 */
export async function addWithTimeout(queue, name, data, opts, timeoutMs = 5_000) {
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new QueuePublishTimeoutError(queue.name, timeoutMs)),
      timeoutMs,
    );
  });
  const adding = queue.add(name, data, opts);
  adding.catch(() => {}); // a late failure after the deadline must not be unhandled
  try {
    return await Promise.race([adding, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
