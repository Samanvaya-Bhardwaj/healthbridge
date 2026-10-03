import { QUEUE_NAMES } from './queues.js';

const { NOTIFICATIONS, PAYMENTS, DOCUMENTS, TIMELINE, FOLLOWUPS } = QUEUE_NAMES;

/**
 * Outbox event type → consuming queues. An event with no consumer is marked dispatched.
 * Each (consumer, event) pair becomes one job with a deterministic id, so publishing the
 * same event twice (relay crash before marking it dispatched) cannot create a second job
 * while the first is retained, and consumers are idempotent beyond that.
 */
export const EVENT_ROUTES = Object.freeze({
  'appointment.booked': [NOTIFICATIONS, TIMELINE],
  'appointment.cancelled': [PAYMENTS, NOTIFICATIONS, TIMELINE],
  'appointment.expired': [PAYMENTS, NOTIFICATIONS, TIMELINE],
  'appointment.confirmed': [TIMELINE],
  'appointment.checked_in': [TIMELINE],
  'appointment.completed': [TIMELINE],
  'appointment.no_show': [TIMELINE],
  'payment.captured': [NOTIFICATIONS],
  'payment.failed': [NOTIFICATIONS],
  'payment.refund_requested': [PAYMENTS],
  'payment.refunded': [NOTIFICATIONS],
  'document.uploaded': [DOCUMENTS],
  // M6: available documents are analysed (patients who opted in) and notified.
  'document.available': [NOTIFICATIONS, DOCUMENTS, TIMELINE],
  'document.analyzed': [TIMELINE],
  'document.retired': [TIMELINE],
  'lab_result.verified': [TIMELINE],
  'document.analysis_requested': [DOCUMENTS],
  'document.rejected': [NOTIFICATIONS],
  // M9: outcome → patient notice (B, C) + timeline; signed prescription → PDF render,
  // notice and timeline. `appointment.in_consultation` updates the appointment's status.
  'appointment.in_consultation': [TIMELINE],
  'consultation.completed': [NOTIFICATIONS, TIMELINE, FOLLOWUPS],
  'prescription.signed': [DOCUMENTS, NOTIFICATIONS, TIMELINE],
  // M10: follow-ups. Reminders and escalations are outbox events (durable), written by
  // the due sweep and the patient's response; AI summaries run on the followups queue.
  'follow_up.created': [TIMELINE],
  'follow_up.reminder_due': [NOTIFICATIONS],
  'follow_up.responded': [NOTIFICATIONS, FOLLOWUPS, TIMELINE],
  'follow_up.no_response': [NOTIFICATIONS, TIMELINE],
  'follow_up.closed': [TIMELINE],
});

export const routesFor = (eventType) => EVENT_ROUTES[eventType] ?? [];

/** BullMQ job ids must not contain ':'. */
export const outboxJobId = (consumer, eventId) => `${consumer}-${eventId}`;
export const reminderJobId = (reminderId) => `reminder-${reminderId}`;
