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
import { bookSlot, outboxOf, paidAppointment, paidSetup, publishPaidWeek } from './m4fixtures.js';

/**
 * Step 11: double submits and parallel actors on the record's one-way steps. Each case fires
 * the same request several times at once and checks the database, not just the replies:
 * exactly one state change, one event downstream, and nothing half-done.
 * (Booking races, closures, webhooks and audit sealing have their own concurrency tests.)
 */
let offsetMs = 0;
const clock = () => new Date(Date.now() + offsetMs);

let h;
let admin;
beforeAll(async () => {
  h = await createHarness({ now: clock });
  admin = await createPlatformAdmin(h);
});
afterAll(async () => {
  await h.close();
});

const PARALLEL = 6;
const statuses = (responses) => responses.map((r) => r.status).sort();

async function liveConsultation(label) {
  offsetMs = 0;
  const doctor = await createVerifiedDoctor(h, admin, `${label}-doc`);
  await publishPaidWeek(h, doctor, { feePaise: 0, mode: 'online' });
  const patient = await createPatient(h, `${label}-pt`);
  await linkCare(h, patient, doctor);
  const appt = await bookSlot(h, patient, doctor);
  offsetMs = new Date(appt.startsAt).getTime() - 5 * 60_000 - Date.now();
  expectOk(await api(h, doctor).post(`/appointments/${appt.id}/consultation/start`));
  return { doctor, patient, appt };
}

describe('one-way steps under parallel requests (step 11)', () => {
  it('a prescription signed several times at once is signed exactly once', async () => {
    const { doctor, appt } = await liveConsultation('cc-rx');
    const draft = expectOk(
      await api(h, doctor).put(`/appointments/${appt.id}/consultation/prescription`, {
        items: [
          {
            drugName: 'Cetirizine',
            dose: '1 tablet',
            frequency: 'once daily',
            duration: '5 days',
          },
        ],
      }),
    );
    const replies = await Promise.all(
      Array.from({ length: PARALLEL }, () =>
        api(h, doctor).post(`/prescriptions/${draft.id}/sign`),
      ),
    );
    expect(statuses(replies).every((s) => s === 200 || s === 409)).toBe(true);
    expect(replies.some((r) => r.status === 200)).toBe(true);
    const rows = await h.ownerKnex('prescriptions').where({ appointment_id: appt.id });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('signed');
    const audits = await h
      .ownerKnex('audit.audit_logs')
      .where({ action: 'prescription.signed', resource_id: draft.id });
    expect(audits).toHaveLength(1);
    offsetMs = 0;
  });

  it('a paid appointment cancelled several times at once is cancelled once, with one event', async () => {
    offsetMs = 0;
    const { doctor, patient } = await paidSetup(h, admin, 'cc-cancel');
    const { appointment } = await paidAppointment(h, patient, doctor);
    const replies = await Promise.all(
      Array.from({ length: PARALLEL }, () =>
        api(h, patient).post(`/appointments/${appointment.id}/cancel`, {
          reasonCode: 'patient_request',
        }),
      ),
    );
    expect(replies.some((r) => r.status === 200)).toBe(true);
    expect(replies.every((r) => r.status === 200 || r.status === 409)).toBe(true);
    const row = await h.ownerKnex('appointments').where({ id: appointment.id }).first();
    expect(row.status).toBe('cancelled');
    const cancelled = (await outboxOf(h, appointment.id)).filter(
      (e) => e.event_type === 'appointment.cancelled',
    );
    expect(cancelled).toHaveLength(1); // so exactly one refund downstream
  });

  it('a check-in answered several times at once keeps one answer', async () => {
    offsetMs = 0;
    const doctor = await createVerifiedDoctor(h, admin, 'cc-fu-doc');
    const patient = await createPatient(h, 'cc-fu-pt');
    await linkCare(h, patient, doctor);
    const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    const followUp = expectOk(
      await api(h, doctor).post(`/patients/${patient.patient.id}/follow-ups`, { dueOn: today }),
      201,
    );
    const replies = await Promise.all(
      Array.from({ length: PARALLEL }, (_, i) =>
        api(h, patient).post(`/follow-ups/${followUp.id}/responses`, {
          overall: i % 2 ? 'better' : 'same',
          redFlags: [],
        }),
      ),
    );
    expect(replies.filter((r) => r.status === 200 || r.status === 201)).toHaveLength(1);
    expect(replies.filter((r) => r.status === 409)).toHaveLength(PARALLEL - 1);
    const answers = await h.ownerKnex('follow_up_responses').where({ follow_up_id: followUp.id });
    expect(answers).toHaveLength(1);
  });
});
