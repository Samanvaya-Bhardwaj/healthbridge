import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withActor } from '../../src/core/db/actorContext.js';
import { createHarness } from './harness.js';
import { api, createPatient, createPlatformAdmin, expectOk } from './m2fixtures.js';
import { bookSlot, outboxOf, paidSetup } from './m4fixtures.js';

/**
 * Step 8: notification preferences. Email (and SMS) per category can be turned off; the
 * in-app inbox always receives everything; safety and payment-hold messages are always
 * sent; a message held back by a preference is recorded as a skipped delivery.
 */
let h;
let admin;
beforeAll(async () => {
  h = await createHarness();
  admin = await createPlatformAdmin(h, 'prefs-admin');
});
afterAll(async () => {
  await h.close();
});

const ALL_ON = {
  email: { appointments: true, payments: true, reminders: true, documents: true, follow_ups: true },
  sms: true,
};

async function deliverEvent(appointmentId, eventType) {
  const event = (await outboxOf(h, appointmentId)).find((e) => e.event_type === eventType);
  return h.container.notificationService.handleEvent({
    eventId: event.id,
    eventType: event.event_type,
    aggregateId: event.aggregate_id,
    payload: event.payload,
  });
}
const emailsTo = (email, template) =>
  h.notificationProvider.sent.filter(
    (m) => m.channel === 'email' && m.to === email && m.template === template,
  );

describe('notification preferences', () => {
  it('start all on, change per category, and are each person’s own', async () => {
    const asha = await createPatient(h, 'prefs-asha');
    const ravi = await createPatient(h, 'prefs-ravi');
    expect(expectOk(await api(h, asha).get('/notifications/preferences'))).toEqual(ALL_ON);

    const updated = expectOk(
      await api(h, asha).put('/notifications/preferences', { email: { reminders: false } }),
    );
    expect(updated.email.reminders).toBe(false);
    expect(updated.email.appointments).toBe(true);
    expect(expectOk(await api(h, asha).get('/notifications/preferences')).email.reminders).toBe(
      false,
    );
    // Someone else sees only their own settings, and RLS hides the row from them.
    expect(expectOk(await api(h, ravi).get('/notifications/preferences'))).toEqual(ALL_ON);
    const seen = await withActor(h.knex, ravi.id, (trx) =>
      trx('notification_preferences').where({ user_id: asha.id }),
    );
    expect(seen).toEqual([]);
    for (const bad of [{}, { email: { spam: false } }, { email: { reminders: 'no' } }]) {
      expect((await api(h, asha).put('/notifications/preferences', bad)).status).toBe(400);
    }
    const audit = await h
      .ownerKnex('audit.audit_logs')
      .where({ action: 'account.notification_preferences_update', resource_id: asha.id });
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({ emailOff: ['reminders'] });
  });

  it('holds back emails the person turned off, keeps the inbox, and always sends payment holds', async () => {
    const { doctor, patient } = await paidSetup(h, admin, 'prefs-pay');
    expectOk(
      await api(h, patient).put('/notifications/preferences', {
        email: { payments: false, appointments: false },
      }),
    );
    // A paid booking: "payment required" holds the slot, so it is always emailed.
    const appt = await bookSlot(h, patient, doctor);
    await deliverEvent(appt.id, 'appointment.booked');
    expect(emailsTo(patient.email, 'payment_required')).toHaveLength(1);

    // Cancel it: the cancellation email is held back (appointments off), but recorded and
    // still in the inbox.
    expectOk(
      await api(h, patient).post(`/appointments/${appt.id}/cancel`, {
        reasonCode: 'patient_request',
      }),
    );
    await deliverEvent(appt.id, 'appointment.cancelled');
    expect(emailsTo(patient.email, 'appointment_cancelled')).toHaveLength(0);
    const skipped = await h
      .ownerKnex('notification_deliveries')
      .where({ recipient_user_id: patient.id, template: 'appointment_cancelled', channel: 'email' })
      .first();
    expect(skipped).toMatchObject({ status: 'skipped', skip_reason: 'preference' });
    const inbox = await h
      .ownerKnex('inbox_notifications')
      .where({ user_id: patient.id, template: 'appointment_cancelled' });
    expect(inbox).toHaveLength(1);
  });
});
