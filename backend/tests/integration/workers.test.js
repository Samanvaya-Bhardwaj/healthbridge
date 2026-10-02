import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Queue } from 'bullmq';
import { z } from 'zod';
import { createHarness, testRedisConfig } from './harness.js';
import { api, createPatient, createPlatformAdmin, expectOk } from './m2fixtures.js';
import {
  appointmentRow,
  bookSlot,
  capturedEvent,
  expireHoldNow,
  outboxOf,
  paidAppointment,
  paidSetup,
  paymentRow,
  pendingPaid,
  postWebhook,
  refundsOf,
} from './m4fixtures.js';
import { createQueues, defaultJobOptions, bullConnection } from '../../src/core/queue/queues.js';
import { createOutboxRelay } from '../../src/core/queue/outboxRelay.js';
import { createWorkerRuntime } from '../../src/core/queue/workerRuntime.js';
import { outboxJobId } from '../../src/core/queue/routing.js';
import { createJobProcessors, MAINTENANCE_JOBS } from '../../src/workers/handlers.js';
import { counterValue, domainMetrics } from '../../src/core/metrics/domain.js';
import { FILES, uploadDocument } from './m5fixtures.js';

const PREFIX = `hbt-${randomUUID().slice(0, 8)}`;
const JOB_OPTIONS = defaultJobOptions({ maxAttempts: 3, backoffMs: 20 });

let h;
let admin;
let queues;
const extraQueues = [];

async function waitFor(check, { timeout = 15_000, interval = 100 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`condition not met within ${timeout} ms (last: ${JSON.stringify(last)})`);
}

const relayFor = (q, overrides = {}) =>
  createOutboxRelay({
    knex: h.knex,
    queues: q,
    publishTimeoutMs: 1_000,
    maxAttempts: 5,
    pollIntervalMs: 50,
    baseBackoffMs: 50,
    ...overrides,
  });

/** Relays until nothing is left, so a test's own event is not behind an old backlog. */
async function drain(relay) {
  for (let i = 0; i < 100; i += 1) {
    const { dispatched, failed } = await relay.runOnce();
    if (dispatched + failed === 0) return;
  }
}

const sentFor = (template) => h.notificationProvider.sent.filter((m) => m.template === template);

beforeAll(async () => {
  queues = createQueues({ redis: testRedisConfig(), prefix: PREFIX, jobOptions: JOB_OPTIONS });
  h = await createHarness({ queues });
  admin = await createPlatformAdmin(h);
});
afterAll(async () => {
  for (const q of [...Object.values(queues).filter((q) => q instanceof Queue), ...extraQueues]) {
    await q.obliterate({ force: true }).catch(() => {});
  }
  await queues.close();
  await Promise.allSettled(extraQueues.map((q) => q.close()));
  await h
    .ownerKnex('dead_letter_jobs')
    .whereIn(
      'queue',
      extraQueues.map((q) => q.name),
    )
    .del();
  await h.close();
}, 60_000);

describe('transactional outbox relay', () => {
  it('publishes committed events once per consumer with deterministic job ids', async () => {
    const { doctor, patient } = await paidSetup(h, admin, 'relay-basic');
    const appt = await bookSlot(h, patient, doctor);
    const [booked] = await outboxOf(h, appt.id);
    expect(booked).toMatchObject({ event_type: 'appointment.booked', status: 'pending' });

    const before = await counterValue(domainMetrics.outboxDispatched);
    await drain(relayFor(queues));
    const row = await h.ownerKnex('outbox_events').where({ id: booked.id }).first();
    expect(row.status).toBe('dispatched');
    expect(row.published_at).not.toBeNull();
    expect(await counterValue(domainMetrics.outboxDispatched)).toBeGreaterThan(before);

    const job = await queues.notifications.getJob(outboxJobId('notifications', booked.id));
    expect(job.name).toBe('appointment.booked');
    expect(job.data).toMatchObject({ eventId: booked.id, aggregateId: appt.id });
    // Identifiers only: no reason for visit, no contact details in Redis.
    expect(JSON.stringify(job.data)).not.toMatch(/Synthetic|follow-up|@|\+91/);
  });

  it('a crash after publishing but before marking dispatched redelivers safely', async () => {
    const { doctor, patient } = await paidSetup(h, admin, 'relay-crash');
    await drain(relayFor(queues));
    const appt = await bookSlot(h, patient, doctor);
    const [event] = await outboxOf(h, appt.id);
    const crashing = relayFor(queues, {
      hooks: {
        afterPublish: async (e) => {
          if (e.id === event.id)
            throw Object.assign(new Error('simulated crash'), { simulatedCrash: true });
        },
      },
    });
    await expect(crashing.runOnce()).rejects.toThrow('simulated crash');
    expect((await h.ownerKnex('outbox_events').where({ id: event.id }).first()).status).toBe(
      'pending',
    );
    expect(await queues.notifications.getJob(outboxJobId('notifications', event.id))).toBeTruthy();

    await relayFor(queues).runOnce(); // recovery: published again, same job id
    expect((await h.ownerKnex('outbox_events').where({ id: event.id }).first()).status).toBe(
      'dispatched',
    );
    const jobs = await queues.notifications.getJobs(['waiting', 'delayed', 'active', 'completed']);
    expect(jobs.filter((j) => j.data.eventId === event.id)).toHaveLength(1);

    // Even if a consumer receives it twice, the effect happens once.
    const data = {
      eventId: event.id,
      eventType: event.event_type,
      aggregateType: 'appointment',
      aggregateId: appt.id,
      payload: event.payload,
    };
    const [a, b] = await Promise.all([
      h.container.notificationService.handleEvent(data),
      h.container.notificationService.handleEvent(data),
    ]);
    expect([a.outcome, b.outcome].sort()).toEqual(['duplicate', 'sent']);
    const deliveries = await h
      .ownerKnex('notification_deliveries')
      .where({ source_event_id: event.id });
    expect(deliveries.filter((d) => d.status === 'sent')).toHaveLength(deliveries.length);
    expect(deliveries.length).toBeGreaterThan(0);
  });

  it('Redis unavailable: events stay in PostgreSQL with backoff, then dead-letter; nothing is lost', async () => {
    const { doctor, patient } = await paidSetup(h, admin, 'relay-redis');
    await drain(relayFor(queues)); // the broken relay below must only see this test's event
    const appt = await bookSlot(h, patient, doctor);
    const [event] = await outboxOf(h, appt.id);
    const broken = createQueues({
      redis: { host: '127.0.0.1', port: 1, password: 'x' },
      prefix: PREFIX,
      jobOptions: JOB_OPTIONS,
    });
    try {
      const failedBefore = await counterValue(domainMetrics.outboxFailed);
      const result = await relayFor(broken).runOnce();
      expect(result.failed).toBeGreaterThan(0);
      let row = await h.ownerKnex('outbox_events').where({ id: event.id }).first();
      expect(row).toMatchObject({ status: 'pending', attempts: 1 });
      expect(row.last_error).toBeTruthy();
      expect(new Date(row.available_at).getTime()).toBeGreaterThan(Date.now() - 1000);
      expect(await counterValue(domainMetrics.outboxFailed)).toBeGreaterThan(failedBefore);

      // Exhausting the attempts parks the event as failed and dead-letters it.
      await h
        .ownerKnex('outbox_events')
        .where({ id: event.id })
        .update({ available_at: h.ownerKnex.fn.now() });
      await relayFor(broken, { maxAttempts: 2 }).runOnce();
      row = await h.ownerKnex('outbox_events').where({ id: event.id }).first();
      expect(row.status).toBe('failed');
      const dead = await h
        .ownerKnex('dead_letter_jobs')
        .where({ queue: 'outbox', job_id: event.id })
        .first();
      expect(dead).toMatchObject({
        status: 'open',
        job_name: 'appointment.booked',
        aggregate_id: appt.id,
      });
      expect(dead.failure_reason.length).toBeLessThanOrEqual(500);

      // Operations retry re-opens the event; Redis is back, so it is relayed.
      const patientUser = await createPatient(h, 'relay-redis-pt');
      expect((await api(h, patientUser).get('/admin/operations/dead-letters')).status).toBe(403);
      const list = expectOk(await api(h, admin).get('/admin/operations/dead-letters'));
      expect(list.map((d) => d.id)).toContain(dead.id);
      expect(JSON.stringify(list)).not.toMatch(/Synthetic|follow-up/);
      expectOk(await api(h, admin).post(`/admin/operations/dead-letters/${dead.id}/retry`));
      expect(
        (await api(h, admin).post(`/admin/operations/dead-letters/${dead.id}/retry`)).body.code,
      ).toBe('already_retried');
      await drain(relayFor(queues));
      expect((await h.ownerKnex('outbox_events').where({ id: event.id }).first()).status).toBe(
        'dispatched',
      );
      const summary = expectOk(await api(h, admin).get('/admin/operations/summary'));
      expect(summary.queues.notifications).toBeDefined();
    } finally {
      await broken.close();
    }
  });
});

describe('BullMQ workers', () => {
  it('retries with backoff, then dead-letters; poisoned jobs go straight to the DLQ', async () => {
    const name = `flaky-${randomUUID().slice(0, 6)}`;
    const flaky = new Queue(name, {
      connection: bullConnection(testRedisConfig()),
      prefix: PREFIX,
    });
    extraQueues.push(flaky);
    let calls = 0;
    const runtime = createWorkerRuntime({
      redis: testRedisConfig(),
      prefix: PREFIX,
      knex: h.knex,
      processors: {
        [name]: {
          schemas: { 'provider.call': z.object({ aggregateId: z.uuid() }) },
          handle: async () => {
            calls += 1;
            throw Object.assign(new Error('provider returned 503'), { kind: 'unavailable' });
          },
        },
      },
    });
    try {
      const retriedBefore = await counterValue(domainMetrics.jobsRetried, { queue: name });
      const flakyJob = await flaky.add(
        'provider.call',
        { aggregateId: randomUUID() },
        { attempts: 3, backoff: { type: 'exponential', delay: 20 } },
      );
      const poison = await flaky.add('provider.call', { bogus: '<script>' }, { attempts: 5 });

      const dead = await waitFor(async () => {
        const rows = await h.ownerKnex('dead_letter_jobs').where({ queue: name });
        return rows.length === 2 ? rows : null;
      });
      const byJob = Object.fromEntries(dead.map((d) => [d.job_id, d]));
      expect(byJob[flakyJob.id]).toMatchObject({ attempts: 3, status: 'open' });
      expect(byJob[flakyJob.id].failure_reason).toMatch(/unavailable/);
      expect(byJob[poison.id].attempts).toBe(1); // no retries for invalid data
      expect(JSON.stringify(byJob[poison.id].data)).not.toMatch(/script/);
      expect(calls).toBe(3);
      expect(await counterValue(domainMetrics.jobsRetried, { queue: name })).toBe(
        retriedBefore + 2,
      );
      expect(await counterValue(domainMetrics.jobsDeadLettered, { queue: name })).toBe(2);
      await waitFor(async () => (await flaky.getJob(poison.id))?.failedReason);
    } finally {
      await runtime.close();
    }
  });

  it('graceful shutdown lets an active job finish', async () => {
    const name = `slow-${randomUUID().slice(0, 6)}`;
    const slow = new Queue(name, { connection: bullConnection(testRedisConfig()), prefix: PREFIX });
    extraQueues.push(slow);
    let started = false;
    let finished = false;
    const runtime = createWorkerRuntime({
      redis: testRedisConfig(),
      prefix: PREFIX,
      knex: h.knex,
      processors: {
        [name]: {
          schemas: { '*': z.any() },
          handle: async () => {
            started = true;
            await new Promise((resolve) => setTimeout(resolve, 400));
            finished = true;
          },
        },
      },
    });
    const job = await slow.add('work', {});
    await waitFor(() => started);
    await runtime.close();
    expect(finished).toBe(true);
    expect(await (await slow.getJob(job.id)).getState()).toBe('completed');
  });

  it(
    'end to end: booking → payment → notifications; doctor cancels → refund → refund notice',
    { timeout: 60_000 },
    async () => {
      const relay = relayFor(queues);
      const runtime = createWorkerRuntime({
        redis: testRedisConfig(),
        prefix: PREFIX,
        knex: h.knex,
        processors: createJobProcessors(h.container, queues),
      });
      relay.start();
      try {
        const { doctor, patient } = await paidSetup(h, admin, 'e2e-worker');
        const { appointment, co } = await pendingPaid(h, patient, doctor, { days: 3 });
        await waitFor(() => sentFor('payment_required').some((m) => m.to === patient.email));
        expectOk(await postWebhook(h, capturedEvent(h, co, appointment.id)));
        await waitFor(() => sentFor('payment_confirmed').some((m) => m.to === patient.email));
        const confirmation = sentFor('payment_confirmed').find((m) => m.to === patient.email);
        expect(confirmation.text).toContain('₹500.00');
        expect(confirmation.text).not.toMatch(/Synthetic|follow-up/); // never the reason for visit

        expectOk(
          await api(h, doctor).post(`/appointments/${appointment.id}/cancel`, {
            reasonCode: 'doctor_unavailable',
          }),
        );
        await waitFor(async () => (await paymentRow(h, appointment.id)).status === 'refunded');
        await waitFor(() => sentFor('payment_refunded').some((m) => m.to === patient.email));
        await waitFor(() => sentFor('appointment_cancelled').some((m) => m.to === patient.email));
        const [refund] = await refundsOf(h, co.payment.id);
        expect(refund).toMatchObject({ status: 'processed', reason: 'appointment_cancelled' });

        // Hold expiry through the maintenance queue.
        const pending = await pendingPaid(h, patient, doctor, { index: 4 });
        await expireHoldNow(h, pending.appointment.id);
        await queues.maintenance.add(MAINTENANCE_JOBS.EXPIRE_HOLDS, {});
        await waitFor(
          async () => (await appointmentRow(h, pending.appointment.id)).status === 'expired',
        );
        await waitFor(
          async () => (await paymentRow(h, pending.appointment.id)).status === 'cancelled',
        );
        await waitFor(() => sentFor('appointment_expired').some((m) => m.to === patient.email));
        const processed = await counterValue(domainMetrics.jobsProcessed);
        expect(processed).toBeGreaterThan(0);
      } finally {
        await relay.stop();
        await runtime.close();
      }
    },
  );

  it('duplicate worker execution of a refund has one provider effect', async () => {
    const { doctor, patient } = await paidSetup(h, admin, 'dup-refund');
    const { appointment, co } = await paidAppointment(h, patient, doctor);
    expectOk(
      await api(h, doctor).post(`/appointments/${appointment.id}/cancel`, {
        reasonCode: 'doctor_unavailable',
      }),
    );
    const s = h.container.settlement;
    await Promise.all([
      s.closeForAppointment(appointment.id),
      s.closeForAppointment(appointment.id),
    ]);
    const refunds = await refundsOf(h, co.payment.id);
    expect(refunds).toHaveLength(1);
    await Promise.all([s.executeRefund(refunds[0].id), s.executeRefund(refunds[0].id)]);
    const [after] = await refundsOf(h, co.payment.id);
    expect(after.status).toBe('processing');
    expect(after.provider_refund_id).toMatch(/^rfnd_fake_/);
  });
});

describe('appointment reminders', () => {
  /** A free, confirmed appointment moved to start soon, confirmed well before. */
  async function soonAppointment(label, minutesAhead) {
    const { doctor, patient } = await paidSetup(h, admin, label, { feePaise: 0 });
    const appt = await bookSlot(h, patient, doctor);
    const start = new Date(Date.now() + minutesAhead * 60_000);
    await h
      .ownerKnex('appointments')
      .where({ id: appt.id })
      .update({
        starts_at: start,
        ends_at: new Date(start.getTime() + 15 * 60_000),
        confirmed_at: new Date(Date.now() - 3 * 86_400_000),
      });
    return { doctor, patient, appt };
  }

  it('sends the nearest due reminder once, even if scheduled and processed repeatedly', async () => {
    const { patient, appt } = await soonAppointment('rem-once', 50);
    const ids = await h.container.notificationService.collectDueReminders();
    const rows = await h.ownerKnex('appointment_reminders').where({ appointment_id: appt.id });
    expect(rows).toHaveLength(1); // the 24-hour reminder is skipped: the 1-hour one is due
    expect(rows[0].offset_minutes).toBe(60);
    expect(ids).toContain(rows[0].id);

    // Rescheduling sweep: no new row; the job id is deterministic.
    await h.container.notificationService.collectDueReminders();
    expect(
      await h.ownerKnex('appointment_reminders').where({ appointment_id: appt.id }),
    ).toHaveLength(1);

    const before = await counterValue(domainMetrics.remindersSent);
    const [r1, r2] = await Promise.all([
      h.container.notificationService.sendReminder(rows[0].id),
      h.container.notificationService.sendReminder(rows[0].id),
    ]);
    expect([r1.outcome, r2.outcome]).toContain('sent');
    expect((await h.container.notificationService.sendReminder(rows[0].id)).outcome).toBe(
      'not_pending',
    );
    const reminders = sentFor('appointment_reminder').filter((m) => m.to === patient.email);
    expect(reminders).toHaveLength(1);
    expect(reminders[0].subject).toMatch(/1 hour/);
    expect(await counterValue(domainMetrics.remindersSent)).toBe(before + 1);
    expect(
      (await h.ownerKnex('appointment_reminders').where({ id: rows[0].id }).first()).status,
    ).toBe('sent');
  });

  it('a lost job (e.g. Redis restart) is re-collected from PostgreSQL', async () => {
    const { appt } = await soonAppointment('rem-lost', 45);
    const [first] = await h.container.notificationService.collectDueReminders();
    expect(first).toBeTruthy();
    expect(await h.container.notificationService.collectDueReminders()).not.toContain(first);
    const again = await h.container.notificationService.collectDueReminders({
      requeueAfterMinutes: 0,
    });
    const row = await h
      .ownerKnex('appointment_reminders')
      .where({ appointment_id: appt.id })
      .first();
    expect(again).toContain(row.id);
    expect(row.enqueue_count).toBe(2);
  });

  it('a cancelled appointment never receives its old reminder', async () => {
    const { patient, appt } = await soonAppointment('rem-cancel', 40);
    await h.container.notificationService.collectDueReminders();
    const reminder = await h
      .ownerKnex('appointment_reminders')
      .where({ appointment_id: appt.id })
      .first();
    expectOk(
      await api(h, patient).post(`/appointments/${appt.id}/cancel`, {
        reasonCode: 'patient_request',
      }),
    );
    expect((await h.container.notificationService.sendReminder(reminder.id)).outcome).toBe(
      'skipped_appointment_cancelled',
    );
    expect(sentFor('appointment_reminder').filter((m) => m.to === patient.email)).toHaveLength(0);
  });

  it('a rescheduled appointment skips the old reminder and gets its own', async () => {
    const { doctor, patient, appt } = await soonAppointment('rem-resched', 55);
    await h.container.notificationService.collectDueReminders();
    const old = await h
      .ownerKnex('appointment_reminders')
      .where({ appointment_id: appt.id })
      .first();

    const qs = new URLSearchParams({
      from: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10),
      to: new Date(Date.now() + 4 * 86_400_000).toISOString().slice(0, 10),
      mode: 'online',
    });
    const [slot] = expectOk(await api(h, patient).get(`/doctors/${doctor.doctor.id}/slots?${qs}`));
    const moved = expectOk(
      await api(h, patient).post(`/appointments/${appt.id}/reschedule`, {
        startsAt: slot.startsAt,
      }),
    );
    expect((await h.container.notificationService.sendReminder(old.id)).outcome).toBe(
      'skipped_appointment_cancelled',
    );

    // The new appointment's reminder is planned for its own start.
    const start = new Date(Date.now() + 30 * 60_000);
    await h
      .ownerKnex('appointments')
      .where({ id: moved.id })
      .update({
        starts_at: start,
        ends_at: new Date(start.getTime() + 15 * 60_000),
        confirmed_at: new Date(Date.now() - 86_400_000),
      });
    await h.container.notificationService.collectDueReminders();
    const fresh = await h
      .ownerKnex('appointment_reminders')
      .where({ appointment_id: moved.id })
      .first();
    expect(fresh.occurrence_starts_at.getTime()).toBe(start.getTime());
    expect((await h.container.notificationService.sendReminder(fresh.id)).outcome).toBe('sent');
    expect(sentFor('appointment_reminder').filter((m) => m.to === patient.email)).toHaveLength(1);
  });

  it('a reminder whose appointment time changed is skipped (occurrence check)', async () => {
    const { appt } = await soonAppointment('rem-moved', 50);
    await h.container.notificationService.collectDueReminders();
    const reminder = await h
      .ownerKnex('appointment_reminders')
      .where({ appointment_id: appt.id })
      .first();
    const later = new Date(Date.now() + 70 * 60_000);
    await h
      .ownerKnex('appointments')
      .where({ id: appt.id })
      .update({ starts_at: later, ends_at: new Date(later.getTime() + 15 * 60_000) });
    expect((await h.container.notificationService.sendReminder(reminder.id)).outcome).toBe(
      'skipped_occurrence_changed',
    );
  });
});

describe('medical documents through the workers (M5)', () => {
  it(
    'upload completed → outbox → documents queue → scan → available → generic notification',
    { timeout: 60_000 },
    async () => {
      const relay = relayFor(queues);
      const runtime = createWorkerRuntime({
        redis: testRedisConfig(),
        prefix: PREFIX,
        knex: h.knex,
        processors: createJobProcessors(h.container, queues),
      });
      relay.start();
      try {
        const patient = await createPatient(h, 'wk-doc');
        const doc = await uploadDocument(h, patient, patient.patient.id, {
          scan: false,
          title: 'Synthetic thyroid panel',
        });
        await waitFor(
          async () =>
            (await h.ownerKnex('medical_documents').where({ id: doc.id }).first()).status ===
            'available',
        );
        await waitFor(() => sentFor('document_available').some((m) => m.to === patient.email));
        const mail = sentFor('document_available').find((m) => m.to === patient.email);
        // Generic wording only: no title, type or content.
        expect(mail.text).not.toMatch(/thyroid|lab_report|lab report|Synthetic/i);

        // A duplicate scan job for the same document changes nothing.
        const [event] = await h
          .ownerKnex('outbox_events')
          .where({ aggregate_id: doc.id, event_type: 'document.uploaded' })
          .select('*');
        await queues.documents.add('document.uploaded', {
          eventId: event.id,
          eventType: event.event_type,
          aggregateType: event.aggregate_type,
          aggregateId: event.aggregate_id,
          payload: event.payload,
        });
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        const promoted = await h.ownerKnex('audit.audit_logs').where({
          resource_id: doc.id,
          action: 'document.promoted',
        });
        expect(promoted).toHaveLength(1);

        // Infected → rejected → generic notice.
        const bad = await uploadDocument(h, patient, patient.patient.id, {
          scan: false,
          content: FILES.infectedPdf(),
        });
        await waitFor(
          async () =>
            (await h.ownerKnex('medical_documents').where({ id: bad.id }).first()).status ===
            'rejected',
        );
        await waitFor(() => sentFor('document_rejected').some((m) => m.to === patient.email));

        // A scanner that keeps failing: retries, then a dead letter; never available.
        const stuck = await uploadDocument(h, patient, patient.patient.id, {
          scan: false,
          content: FILES.scannerFailurePdf(),
        });
        const dead = await waitFor(async () =>
          h
            .ownerKnex('dead_letter_jobs')
            .where({ queue: 'documents', aggregate_id: stuck.id })
            .first(),
        );
        expect(dead.failure_reason).toMatch(/ScannerError/);
        expect(
          (await h.ownerKnex('medical_documents').where({ id: stuck.id }).first()).status,
        ).toBe('quarantined');
        expect(await counterValue(domainMetrics.documentWorkerDlq)).toBeGreaterThan(0);
      } finally {
        await relay.stop();
        await runtime.close();
      }
    },
  );
});
