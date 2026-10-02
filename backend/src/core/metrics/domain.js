import client from 'prom-client';

/**
 * Business and background-processing metrics (M4). One registry per process, merged into
 * the API and worker /metrics endpoints. Labels are low-cardinality enums only — never
 * identifiers, amounts or anything patient-related.
 */
export const domainRegistry = new client.Registry();

const counter = (name, help, labelNames = []) =>
  new client.Counter({ name, help, labelNames, registers: [domainRegistry] });
const histogram = (name, help, labelNames = []) =>
  new client.Histogram({
    name,
    help,
    labelNames,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    registers: [domainRegistry],
  });

export const domainMetrics = Object.freeze({
  paymentsCreated: counter('payments_created_total', 'Payment orders created'),
  paymentsSucceeded: counter('payments_succeeded_total', 'Payments captured (verified webhook)'),
  paymentsFailed: counter('payments_failed_total', 'Payment attempts reported failed'),
  webhooksReceived: counter('payment_webhooks_received_total', 'Payment webhooks received', [
    'provider',
  ]),
  webhooksDuplicate: counter(
    'payment_webhooks_duplicate_total',
    'Duplicate or replayed payment webhooks (idempotent no-op)',
  ),
  webhooksInvalid: counter('payment_webhooks_invalid_total', 'Rejected payment webhooks', [
    'reason',
  ]),
  refundsCreated: counter('refunds_created_total', 'Refunds requested', ['reason']),
  refundsCompleted: counter('refunds_completed_total', 'Refunds processed by the provider'),
  outboxCreated: counter('outbox_events_created_total', 'Outbox events written'),
  outboxDispatched: counter('outbox_events_dispatched_total', 'Outbox events relayed'),
  outboxFailed: counter('outbox_events_failed_total', 'Outbox relay failures', ['final']),
  jobsProcessed: counter('queue_jobs_processed_total', 'Jobs completed', ['queue']),
  jobsFailed: counter('queue_jobs_failed_total', 'Job attempts failed', ['queue']),
  jobsRetried: counter('queue_jobs_retried_total', 'Job attempts scheduled for retry', ['queue']),
  jobsDeadLettered: counter('queue_jobs_dlq_total', 'Jobs moved to the dead-letter table', [
    'queue',
  ]),
  holdsExpired: counter('appointment_holds_expired_total', 'Payment holds expired by the sweeper'),
  notificationsSent: counter('notifications_sent_total', 'Notifications delivered', [
    'channel',
    'template',
  ]),
  notificationsFailed: counter('notifications_failed_total', 'Notification delivery failures', [
    'channel',
  ]),
  remindersSent: counter('reminders_sent_total', 'Appointment reminders delivered'),

  providerLatency: histogram('payment_provider_duration_seconds', 'Payment provider call latency', [
    'operation',
    'outcome',
  ]),
  webhookLatency: histogram(
    'payment_webhook_processing_duration_seconds',
    'Webhook verification and processing latency',
    ['outcome'],
  ),
  outboxRelayLatency: histogram('outbox_relay_batch_duration_seconds', 'Outbox relay batch time'),
  jobLatency: histogram('worker_job_duration_seconds', 'Worker job execution time', [
    'queue',
    'outcome',
  ]),
  notificationLatency: histogram(
    'notification_provider_duration_seconds',
    'Notification provider latency',
    ['channel', 'outcome'],
  ),
});

/** Times an async call into a histogram with an outcome label. */
export async function timed(hist, labels, fn) {
  const end = hist.startTimer(labels);
  try {
    const result = await fn();
    end({ outcome: 'success' });
    return result;
  } catch (err) {
    end({ outcome: err?.kind ?? 'error' });
    throw err;
  }
}

/** Current value of a counter (summed over labels); used by tests and diagnostics. */
export async function counterValue(metric, labels) {
  const { values } = await metric.get();
  return values
    .filter((v) => !labels || Object.entries(labels).every(([k, val]) => v.labels[k] === val))
    .reduce((sum, v) => sum + v.value, 0);
}
