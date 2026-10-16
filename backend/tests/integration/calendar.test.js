import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { authHeader, createHarness } from './harness.js';
import {
  api,
  createPatient,
  createPlatformAdmin,
  createVerifiedDoctor,
  expectOk,
  linkCare,
} from './m2fixtures.js';
import { bookSlot, outboxOf, publishPaidWeek } from './m4fixtures.js';

/**
 * Step 7+: booked, moved and cancelled appointments update the patient side's calendar.
 * The confirmation email carries an invitation (one entry per booking chain), and the
 * patient side can download the same entry.
 */
let h;
let admin;
beforeAll(async () => {
  h = await createHarness();
  admin = await createPlatformAdmin(h, 'cal-admin');
});
afterAll(async () => {
  await h.close();
});

const unfold = (ics) => ics.replace(/\r\n /g, '');

async function deliver(appointmentId, eventType) {
  const event = (await outboxOf(h, appointmentId)).find((e) => e.event_type === eventType);
  await h.container.notificationService.handleEvent({
    eventId: event.id,
    eventType: event.event_type,
    aggregateId: event.aggregate_id,
    payload: event.payload,
  });
}
const invitationsTo = (email) =>
  h.notificationProvider.sent.filter((m) => m.channel === 'email' && m.to === email && m.calendar);

describe('calendar invitations', () => {
  it('book → move → cancel keeps one calendar entry, updated each time', async () => {
    const doctor = await createVerifiedDoctor(h, admin, 'cal-doc');
    await publishPaidWeek(h, doctor, { feePaise: 0, mode: 'online' });
    const patient = await createPatient(h, 'cal-pt');
    await linkCare(h, patient, doctor);
    const booked = await bookSlot(h, patient, doctor, { index: 0, days: 2 });
    await deliver(booked.id, 'appointment.booked');
    const [first] = invitationsTo(patient.email);
    expect(first.calendar.method).toBe('REQUEST');
    const ics = unfold(first.calendar.content);
    expect(ics).toContain(`UID:appointment-${booked.id}@healthbridge`);
    expect(ics).toContain('SEQUENCE:0');
    expect(ics).toContain(`SUMMARY:HealthBridge: online consultation with Dr. cal-doc`);
    expect(ics).toContain(`ATTENDEE;CN=`);
    expect(ics).not.toContain('Synthetic'); // never the reason for the visit
    expect(first.text).toContain('A calendar invitation is attached');

    const qs = new URLSearchParams({
      from: booked.startsAt.slice(0, 10),
      to: booked.startsAt.slice(0, 10),
      mode: 'online',
    });
    const slots = expectOk(await api(h, patient).get(`/doctors/${doctor.doctor.id}/slots?${qs}`));
    const later = slots.find((s) => s.startsAt !== booked.startsAt);
    const moved = expectOk(
      await api(h, patient).post(`/appointments/${booked.id}/reschedule`, {
        startsAt: later.startsAt,
      }),
    );
    await deliver(moved.id, 'appointment.booked');
    const second = invitationsTo(patient.email).at(-1);
    expect(second.template).toBe('appointment_rescheduled');
    expect(unfold(second.calendar.content)).toContain(`UID:appointment-${booked.id}@healthbridge`);
    expect(second.calendar.content).toContain('SEQUENCE:2');

    expectOk(
      await api(h, patient).post(`/appointments/${moved.id}/cancel`, {
        reasonCode: 'patient_request',
      }),
    );
    await deliver(moved.id, 'appointment.cancelled');
    const third = invitationsTo(patient.email).at(-1);
    expect(third.calendar.method).toBe('CANCEL');
    expect(third.calendar.content).toContain('SEQUENCE:3');
    expect(third.calendar.content).toContain('STATUS:CANCELLED');
  });

  it('the patient side downloads the entry; the doctor and strangers cannot', async () => {
    const doctor = await createVerifiedDoctor(h, admin, 'cal-doc2');
    await publishPaidWeek(h, doctor, { feePaise: 0, mode: 'online' });
    const patient = await createPatient(h, 'cal-pt2');
    const stranger = await createPatient(h, 'cal-stranger');
    await linkCare(h, patient, doctor);
    const booked = await bookSlot(h, patient, doctor);
    const get = (who) =>
      request(h.app)
        .get(`/api/v1/appointments/${booked.id}/calendar.ics`)
        .set(authHeader(who.session));
    const res = await get(patient);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/calendar/);
    expect(res.headers['content-disposition']).toMatch(/healthbridge-[0-9A-F]{8}\.ics/);
    expect(res.text).toContain('METHOD:PUBLISH');
    expect(res.text).toContain(`UID:appointment-${booked.id}@healthbridge`);
    expect((await get(doctor)).status).toBe(403);
    expect((await get(stranger)).status).toBe(404);
  });
});
