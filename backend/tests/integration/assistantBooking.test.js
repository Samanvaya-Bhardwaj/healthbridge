import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness } from './harness.js';
import {
  api,
  createPatient,
  createPlatformAdmin,
  createVerifiedDoctor,
  expectOk,
  linkCare,
} from './m2fixtures.js';
import { isoDate, outboxOf, publishPaidWeek } from './m4fixtures.js';

/**
 * ADR-0038: booking in the conversation. The AI step can only ask for a booking card; the
 * backend re-checks the slot and stores a proposal; only the person's Confirm books it,
 * through the one booking path, once.
 */
let script = () => {
  throw new Error('no script');
};
const ai = { agentStep: async (input) => script(input) };

let h;
let admin;
beforeAll(async () => {
  h = await createHarness({ aiClient: ai });
  admin = await createPlatformAdmin(h, 'ab-admin');
});
afterAll(async () => {
  await h.close();
});

/** A planner that proposes one time with a doctor (as the graph does after a tap). */
const proposing = (doctorId, startsAt) => (input) => ({
  state: { ...input.state, intent: 'book_appointment', bookingDoctorId: doctorId },
  action: { type: 'respond' },
  reply: {
    kind: 'confirm',
    message: "Here's the booking. Check the details, then tap Confirm booking.",
    cards: [{ type: 'booking', doctorId, startsAt }],
  },
  run: { runId: randomUUID() },
});

async function doctorWithWeek(label, { feePaise = 0, acceptsNewPatients = false } = {}) {
  const doctor = await createVerifiedDoctor(h, admin, label);
  await publishPaidWeek(h, doctor, { feePaise, mode: 'online' });
  if (acceptsNewPatients) {
    expectOk(await api(h, doctor).patch('/doctors/me', { acceptsNewPatients: true }));
  }
  return doctor;
}
async function aSlot(patient, doctor) {
  const qs = new URLSearchParams({ from: isoDate(2), to: isoDate(3), mode: 'online' });
  return expectOk(await api(h, patient).get(`/doctors/${doctor.doctor.id}/slots?${qs}`))[0];
}
const session = async (who) => expectOk(await api(h, who).post('/assistant/sessions', {}), 201);
const say = (who, s, version = 1) =>
  api(h, who).post(`/assistant/sessions/${s.id}/messages`, {
    text: 'that time please',
    version,
    timeZone: 'Asia/Kolkata',
  });
const confirm = (who, s, actionId, reason = 'Synthetic: follow-up on blood pressure') =>
  api(h, who).post(`/assistant/sessions/${s.id}/actions/${actionId}/confirm`, { reason });

describe('booking through the assistant (ADR-0038)', () => {
  it('proposes a real slot, and books it once on Confirm', async () => {
    const doctor = await doctorWithWeek('ab-doc1');
    const patient = await createPatient(h, 'ab-pt1');
    await linkCare(h, patient, doctor);
    const slot = await aSlot(patient, doctor);
    const s = await session(patient);
    script = proposing(doctor.doctor.id, slot.startsAt);
    const turn = expectOk(await say(patient, s));
    const card = turn.reply.cards.find((c) => c.type === 'booking');
    expect(card).toMatchObject({
      doctor: { id: doctor.doctor.id, professionalName: 'Dr. ab-doc1' },
      mode: 'online',
      feePaise: 0,
      careStatus: 'active',
      joinsCareTeam: false,
    });
    expect(new Date(card.startsAt).getTime()).toBe(new Date(slot.startsAt).getTime());
    // Proposed, not booked.
    expect(await h.ownerKnex('appointments').where({ patient_id: patient.patient.id })).toEqual([]);

    const done = expectOk(await confirm(patient, s, card.actionId));
    expect(done).toMatchObject({ status: 'done', appointmentStatus: 'confirmed' });
    expect(done.appointment.reason).toBe('Synthetic: follow-up on blood pressure');
    // A second tap returns the same booking.
    const again = expectOk(await confirm(patient, s, card.actionId));
    expect(again.appointmentId).toBe(done.appointmentId);
    const rows = await h.ownerKnex('appointments').where({ patient_id: patient.patient.id });
    expect(rows).toHaveLength(1);
    expect((await outboxOf(h, done.appointmentId)).map((e) => e.event_type)).toContain(
      'appointment.booked',
    );
    const audits = await h
      .ownerKnex('audit.audit_logs')
      .where({ resource_id: card.actionId })
      .orderBy('occurred_at');
    expect(audits.map((a) => a.action)).toEqual([
      'assistant.action_proposed',
      'assistant.action_confirmed',
    ]);
  });

  it('drops a booking card for a time that is not offered, and stores nothing', async () => {
    const doctor = await doctorWithWeek('ab-doc2');
    const patient = await createPatient(h, 'ab-pt2');
    await linkCare(h, patient, doctor);
    const s = await session(patient);
    script = proposing(doctor.doctor.id, '2030-01-01T03:07:00Z');
    const turn = expectOk(await say(patient, s));
    expect(turn.reply.cards.some((c) => c.type === 'booking')).toBe(false);
    expect(turn.reply.message).toContain('isn’t free any more');
    expect(
      await h.ownerKnex('assistant_actions').where({ patient_id: patient.patient.id }),
    ).toEqual([]);
  });

  it('joins the care team: at once when the doctor accepts new patients, else waits', async () => {
    const open = await doctorWithWeek('ab-open', { acceptsNewPatients: true });
    const closed = await doctorWithWeek('ab-closed');
    const patient = await createPatient(h, 'ab-pt3');
    const s = await session(patient);

    script = proposing(open.doctor.id, (await aSlot(patient, open)).startsAt);
    const first = expectOk(await say(patient, s, 1));
    const card = first.reply.cards[0];
    expect(card).toMatchObject({ joinsCareTeam: true, acceptsNewPatients: true });
    const booked = expectOk(await confirm(patient, s, card.actionId));
    expect(booked.status).toBe('done');
    const care = await h
      .ownerKnex('care_relationships')
      .where({ patient_id: patient.patient.id, doctor_id: open.doctor.id })
      .first();
    expect(care.status).toBe('active');

    script = proposing(closed.doctor.id, (await aSlot(patient, closed)).startsAt);
    const second = expectOk(await say(patient, s, first.session.version));
    const waiting = expectOk(await confirm(patient, s, second.reply.cards[0].actionId));
    expect(waiting).toMatchObject({ status: 'awaiting_doctor', careStatus: 'pending' });
    expect(
      await h.ownerKnex('appointments').where({
        patient_id: patient.patient.id,
        doctor_id: closed.doctor.id,
      }),
    ).toEqual([]);
  });

  it('refuses an expired proposal, and someone else’s', async () => {
    const doctor = await doctorWithWeek('ab-doc4');
    const patient = await createPatient(h, 'ab-pt4');
    const other = await createPatient(h, 'ab-other');
    await linkCare(h, patient, doctor);
    const s = await session(patient);
    script = proposing(doctor.doctor.id, (await aSlot(patient, doctor)).startsAt);
    const card = expectOk(await say(patient, s)).reply.cards[0];
    expect((await confirm(other, s, card.actionId)).status).toBe(404);
    await h
      .ownerKnex('assistant_actions')
      .where({ id: card.actionId })
      .update({
        created_at: h.ownerKnex.raw("now() - interval '30 minutes'"),
        expires_at: h.ownerKnex.raw("now() - interval '1 minute'"),
      });
    const expired = await confirm(patient, s, card.actionId);
    expect(expired.status).toBe(409);
    expect(expired.body.code).toBe('assistant_action_expired');
    expect((await confirm(patient, s, card.actionId, 'no')).status).toBe(400); // reason too short
  });

  it('a paid time is held for payment, and checkout works as on the booking page', async () => {
    const doctor = await doctorWithWeek('ab-paid', { feePaise: 50_000 });
    const patient = await createPatient(h, 'ab-pt5');
    await linkCare(h, patient, doctor);
    const s = await session(patient);
    script = proposing(doctor.doctor.id, (await aSlot(patient, doctor)).startsAt);
    const card = expectOk(await say(patient, s)).reply.cards[0];
    expect(card.feePaise).toBe(50_000);
    const done = expectOk(await confirm(patient, s, card.actionId));
    expect(done.appointmentStatus).toBe('pending_payment');
    const checkout = expectOk(
      await api(h, patient).post(`/appointments/${done.appointmentId}/payment`),
    );
    expect(checkout.payment.amountPaise).toBe(50_000);
  });
});
