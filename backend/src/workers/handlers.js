import { z } from 'zod';
import { QUEUE_NAMES, addWithTimeout } from '../core/queue/queues.js';
import { reminderJobId } from '../core/queue/routing.js';

const uuid = z.uuid();
/** Outbox jobs carry identifiers and non-sensitive attributes only. */
const outboxJob = z.looseObject({
  eventId: uuid,
  eventType: z.string().regex(/^[a-z_]+\.[a-z_]+$/),
  aggregateType: z.string().max(40),
  aggregateId: uuid,
  payload: z.record(z.string(), z.unknown()).default({}),
});
const reminderJob = z.object({ reminderId: uuid }).strict();
const maintenanceJob = z.looseObject({});

export const MAINTENANCE_JOBS = Object.freeze({
  EXPIRE_HOLDS: 'expire-holds',
  SCHEDULE_REMINDERS: 'schedule-reminders',
});

/**
 * Job processors per queue. Every handler is idempotent: jobs may be delivered more
 * than once (outbox re-publish, retries, stalled-job recovery).
 *
 * @param {ReturnType<typeof import('../container.js').createContainer>} container
 * @param {Record<string, import('bullmq').Queue>} queues
 */
export function createJobProcessors(container, queues) {
  const { settlement, notificationService, paymentProvider, config, logger } = container;

  // With the fake provider (development/demo), nothing external sends refund webhooks:
  // emulate the provider by delivering a signed `refund.processed` through the normal
  // webhook path once the refund is submitted.
  const autoSettleRefunds =
    paymentProvider.name === 'fake' &&
    config.payments.simulationEnabled &&
    container.options?.fakeAutoSettleRefunds !== false;

  return {
    [QUEUE_NAMES.NOTIFICATIONS]: {
      concurrency: 8,
      schemas: { '*': outboxJob },
      handle: (job) => notificationService.handleEvent(job.data),
    },
    [QUEUE_NAMES.PAYMENTS]: {
      concurrency: 4,
      schemas: { '*': outboxJob },
      async handle(job) {
        const { eventType, aggregateId, payload } = job.data;
        if (eventType === 'appointment.cancelled' || eventType === 'appointment.expired') {
          return settlement.closeForAppointment(aggregateId);
        }
        if (eventType === 'payment.refund_requested') {
          const result = await settlement.executeRefund(payload.refundId);
          if (result.outcome === 'submitted' && autoSettleRefunds) {
            await container.fakeRefundSettler(payload.refundId);
          }
          return result;
        }
        logger?.warn({ eventType }, 'payments queue received an unrouted event');
        return { outcome: 'ignored' };
      },
    },
    [QUEUE_NAMES.APPOINTMENTS]: {
      concurrency: 4,
      schemas: { 'appointment.reminder': reminderJob },
      handle: (job) => notificationService.sendReminder(job.data.reminderId),
    },
    [QUEUE_NAMES.MAINTENANCE]: {
      concurrency: 1,
      schemas: {
        [MAINTENANCE_JOBS.EXPIRE_HOLDS]: maintenanceJob,
        [MAINTENANCE_JOBS.SCHEDULE_REMINDERS]: maintenanceJob,
      },
      async handle(job) {
        if (job.name === MAINTENANCE_JOBS.EXPIRE_HOLDS) return settlement.expireHolds();
        const ids = await notificationService.collectDueReminders();
        for (const reminderId of ids) {
          // A failed enqueue is retried from PostgreSQL by a later sweep (enqueued_at).
          await addWithTimeout(
            queues[QUEUE_NAMES.APPOINTMENTS],
            'appointment.reminder',
            { reminderId },
            { jobId: reminderJobId(reminderId) },
          );
        }
        return { enqueued: ids.length };
      },
    },
  };
}

/** Registers the periodic maintenance jobs (one schedule per name across all workers). */
export async function registerSchedules(queues, workers) {
  const maintenance = queues[QUEUE_NAMES.MAINTENANCE];
  await maintenance.upsertJobScheduler(
    MAINTENANCE_JOBS.EXPIRE_HOLDS,
    { every: workers.holdSweepIntervalMs },
    { name: MAINTENANCE_JOBS.EXPIRE_HOLDS, data: {}, opts: { attempts: 1 } },
  );
  await maintenance.upsertJobScheduler(
    MAINTENANCE_JOBS.SCHEDULE_REMINDERS,
    { every: workers.reminderSweepIntervalMs },
    { name: MAINTENANCE_JOBS.SCHEDULE_REMINDERS, data: {}, opts: { attempts: 1 } },
  );
}
