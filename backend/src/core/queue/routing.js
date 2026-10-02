import { QUEUE_NAMES } from './queues.js';

const { NOTIFICATIONS, PAYMENTS, DOCUMENTS } = QUEUE_NAMES;

/**
 * Outbox event type → consuming queues. An event with no consumer is marked dispatched.
 * Each (consumer, event) pair becomes one job with a deterministic id, so publishing the
 * same event twice (relay crash before marking it dispatched) cannot create a second job
 * while the first is retained, and consumers are idempotent beyond that.
 */
export const EVENT_ROUTES = Object.freeze({
  'appointment.booked': [NOTIFICATIONS],
  'appointment.cancelled': [PAYMENTS, NOTIFICATIONS],
  'appointment.expired': [PAYMENTS, NOTIFICATIONS],
  'payment.captured': [NOTIFICATIONS],
  'payment.failed': [NOTIFICATIONS],
  'payment.refund_requested': [PAYMENTS],
  'payment.refunded': [NOTIFICATIONS],
  'document.uploaded': [DOCUMENTS],
  // M6: available documents are analysed (patients who opted in) and notified.
  'document.available': [NOTIFICATIONS, DOCUMENTS],
  'document.analysis_requested': [DOCUMENTS],
  'document.rejected': [NOTIFICATIONS],
});

export const routesFor = (eventType) => EVENT_ROUTES[eventType] ?? [];

/** BullMQ job ids must not contain ':'. */
export const outboxJobId = (consumer, eventId) => `${consumer}-${eventId}`;
export const reminderJobId = (reminderId) => `reminder-${reminderId}`;
