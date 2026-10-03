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
const documentJob = outboxJob.refine((j) => uuid.safeParse(j.payload?.documentId).success);
const prescriptionJob = outboxJob.refine((j) => uuid.safeParse(j.payload?.prescriptionId).success);
const maintenanceJob = z.looseObject({});

export const MAINTENANCE_JOBS = Object.freeze({
  EXPIRE_HOLDS: 'expire-holds',
  SCHEDULE_REMINDERS: 'schedule-reminders',
  RECORDS_HOUSEKEEPING: 'records-housekeeping',
  TIMELINE_BACKFILL: 'timeline-backfill',
});

/**
 * Job processors per queue. Every handler is idempotent: jobs may be delivered more
 * than once (outbox re-publish, retries, stalled-job recovery).
 *
 * @param {ReturnType<typeof import('../container.js').createContainer>} container
 * @param {Record<string, import('bullmq').Queue>} queues
 */
export function createJobProcessors(container, queues) {
  const {
    settlement,
    notificationService,
    paymentProvider,
    config,
    logger,
    documentPipeline,
    consentService,
    intelligenceService,
    timelineProjector,
    prescriptionService,
  } = container;

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
    // M5: quarantine → scan → promotion. Idempotent: see modules/documents/pipeline.js.
    [QUEUE_NAMES.DOCUMENTS]: {
      concurrency: 2,
      schemas: {
        'document.uploaded': documentJob,
        'document.available': documentJob,
        'document.analysis_requested': documentJob,
        'prescription.signed': prescriptionJob,
      },
      handle(job) {
        // M9: signed prescription → immutable PDF (rendered once, integrity-checked).
        if (job.name === 'prescription.signed') {
          return prescriptionService.renderPdf(job.data.payload.prescriptionId);
        }
        const { documentId } = job.data.payload;
        if (job.name === 'document.uploaded') return documentPipeline.scanAndPromote(documentId);
        // M6: AI analysis (opt-in, idempotent; AI-service errors are retried).
        return intelligenceService.analyzeDocument(documentId, { requestId: job.data.requestId });
      },
    },
    // M7: projection of appointments, documents and verified lab values.
    [QUEUE_NAMES.TIMELINE]: {
      concurrency: 4,
      schemas: { '*': outboxJob },
      handle: (job) => timelineProjector.handleEvent(job.data),
    },
    [QUEUE_NAMES.MAINTENANCE]: {
      concurrency: 1,
      schemas: {
        [MAINTENANCE_JOBS.EXPIRE_HOLDS]: maintenanceJob,
        [MAINTENANCE_JOBS.SCHEDULE_REMINDERS]: maintenanceJob,
        [MAINTENANCE_JOBS.RECORDS_HOUSEKEEPING]: maintenanceJob,
        [MAINTENANCE_JOBS.TIMELINE_BACKFILL]: maintenanceJob,
      },
      async handle(job) {
        if (job.name === MAINTENANCE_JOBS.EXPIRE_HOLDS) return settlement.expireHolds();
        if (job.name === MAINTENANCE_JOBS.TIMELINE_BACKFILL) return timelineProjector.backfill();
        if (job.name === MAINTENANCE_JOBS.RECORDS_HOUSEKEEPING) {
          return {
            consents: await consentService.expireDue(),
            uploads: await documentPipeline.expireStaleIntents(),
          };
        }
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
  // One-off backfill for patients whose sources predate the projection (idempotent).
  await maintenance.add(
    MAINTENANCE_JOBS.TIMELINE_BACKFILL,
    {},
    { jobId: 'timeline-backfill-v1', attempts: 3 },
  );
  await maintenance.upsertJobScheduler(
    MAINTENANCE_JOBS.RECORDS_HOUSEKEEPING,
    { every: 60_000 },
    { name: MAINTENANCE_JOBS.RECORDS_HOUSEKEEPING, data: {}, opts: { attempts: 1 } },
  );
}
