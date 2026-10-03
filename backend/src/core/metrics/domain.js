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

  // M5: consent and medical documents
  documentUploadIntents: counter('document_upload_intents_total', 'Document upload intents'),
  documentUploadCompleted: counter('document_upload_completed_total', 'Uploads completed'),
  documentScanStarted: counter('document_scan_started_total', 'Document scans started'),
  documentScanSuccess: counter('document_scan_success_total', 'Documents scanned clean'),
  documentScanFailed: counter('document_scan_failed_total', 'Scanner failures (retried)'),
  documentScanRejected: counter('document_scan_rejected_total', 'Documents rejected', ['reason']),
  documentPromoted: counter('document_promoted_total', 'Documents promoted to available'),
  documentDownloads: counter('document_downloads_total', 'Download URLs issued'),
  documentAccessDenied: counter('document_access_denied_total', 'Document access denials'),
  consentGranted: counter('consent_granted_total', 'Consents granted', ['kind']),
  consentRevoked: counter('consent_revoked_total', 'Consents revoked or expired', ['cause']),
  consentDenied: counter('consent_denied_total', 'Requests denied for lack of consent'),
  documentWorkerFailures: counter('document_worker_failures_total', 'Document job failures'),
  documentWorkerRetries: counter('document_worker_retries_total', 'Document job retries'),
  documentWorkerDlq: counter('document_worker_dlq_total', 'Document jobs dead-lettered'),

  // M6: document intelligence
  documentsAnalyzed: counter('documents_analyzed_total', 'AI document analyses committed', [
    'status',
  ]),
  labResultsVerified: counter('lab_results_verified_total', 'Lab values verified by doctors'),

  // M8: AI assistance
  aiAssistRequests: counter('ai_assist_requests_total', 'Record questions and briefs', [
    'kind',
    'status',
  ]),
  briefFeedback: counter('brief_feedback_total', 'Doctor feedback on briefs', ['rating']),

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
