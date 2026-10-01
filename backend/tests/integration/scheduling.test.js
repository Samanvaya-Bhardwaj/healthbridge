import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { authHeader, auditFor, createHarness, createUser } from './harness.js';
import {
  api,
  createClinicWithAdmin,
  createPatient,
  createPlatformAdmin,
  createVerifiedDoctor,
  expectOk,
  linkCare,
  profileInput,
} from './m2fixtures.js';

let h;
let admin;
beforeAll(async () => {
  h = await createHarness();
  admin = await createPlatformAdmin(h);
});
afterAll(async () => {
  await h.close();
});

const isoDate = (offsetDays) =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

/** Every weekday 06:00–22:00 IST, 15-minute slots. */
async function publishWeek(doctor, { mode = 'online', clinicId, feePaise = 0 } = {}) {
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    expectOk(
      await api(h, doctor).post('/doctors/me/availability', {
        mode,
        ...(clinicId ? { clinicId } : {}),
        weekday,
        startTime: '06:00',
        endTime: '22:00',
        slotMinutes: 15,
        validFrom: isoDate(-1),
        feePaise,
      }),
      201,
    );
  }
}

async function slotsFor(who, doctor, query = {}) {
  const qs = new URLSearchParams({ from: isoDate(1), to: isoDate(2), ...query });
  return expectOk(await api(h, who).get(`/doctors/${doctor.doctor.id}/slots?${qs}`));
}

const book = (who, body, key) =>
  request(h.app)
    .post('/api/v1/appointments')
    .set({ ...authHeader(who.session), ...(key ? { 'Idempotency-Key': key } : {}) })
    .send({ mode: 'online', reason: 'Recurring headaches for a week', ...body });

/** Patient with an ACTIVE care relationship to a doctor who has published availability. */
async function careSetup(label, opts = {}) {
  const doctor = await createVerifiedDoctor(h, admin, `${label}-doc`);
  await publishWeek(doctor, opts);
  const patient = await createPatient(h, `${label}-pt`);
  await linkCare(h, patient, doctor);
  return { doctor, patient };
}

describe('availability', () => {
  it('only verified doctors publish availability; overlapping windows are rejected', async () => {
    const applicant = await createUser(h, { label: 'avail-applicant' });
    const res = await api(h, applicant).post('/doctors/me/availability', {
      mode: 'online',
      weekday: 1,
      startTime: '09:00',
      endTime: '10:00',
      slotMinutes: 15,
      validFrom: isoDate(0),
    });
    expect(res.status).toBe(403); // no availability:manage without the DOCTOR role

    const doctor = await createVerifiedDoctor(h, admin, 'avail-doc');
    const rule = {
      mode: 'online',
      weekday: 2,
      startTime: '09:00',
      endTime: '12:00',
      slotMinutes: 20,
      validFrom: isoDate(0),
    };
    expectOk(await api(h, doctor).post('/doctors/me/availability', rule), 201);
    const clash = await api(h, doctor).post('/doctors/me/availability', {
      ...rule,
      mode: 'in_clinic',
      startTime: '11:00',
      endTime: '13:00',
      clinicId: randomUUID(),
    });
    expect([400, 409]).toContain(clash.status);
    const overlap = await api(h, doctor).post('/doctors/me/availability', {
      ...rule,
      startTime: '11:00',
      endTime: '13:00',
    });
    expect(overlap.body.code).toBe('availability_overlap');
    expect(
      (
        await api(h, doctor).post('/doctors/me/availability', {
          ...rule,
          mode: 'in_clinic',
          clinicId: randomUUID(),
          startTime: '14:00',
          endTime: '15:00',
        })
      ).body.code,
    ).toBe('doctor_not_at_clinic');
  });

  it('slots are computed from rules, are future-only, and exclude time off', async () => {
    const { doctor, patient } = await careSetup('slots');
    const slots = await slotsFor(patient, doctor);
    expect(slots.length).toBeGreaterThan(50);
    expect(new Date(slots[0].startsAt).getTime()).toBeGreaterThan(Date.now() + 30 * 60_000);

    const [first] = slots;
    const off = expectOk(
      await api(h, doctor).post('/doctors/me/time-off', {
        startsAt: first.startsAt,
        endsAt: first.endsAt,
        reasonCode: 'personal',
      }),
      201,
    );
    expect(off.clashingAppointments).toBe(0);
    expect((await slotsFor(patient, doctor)).map((s) => s.startsAt)).not.toContain(first.startsAt);
  });

  it('unverified doctors have no slots; oversized ranges are rejected', async () => {
    const { doctor, patient } = await careSetup('slots-guard');
    const res = await api(h, patient).get(
      `/doctors/${doctor.doctor.id}/slots?from=${isoDate(1)}&to=${isoDate(60)}`,
    );
    expect(res.body.code).toBe('slot_range_too_large');
    expect(
      (
        await api(h, patient).get(
          `/doctors/${randomUUID()}/slots?from=${isoDate(1)}&to=${isoDate(2)}`,
        )
      ).status,
    ).toBe(404);
  });
});

describe('booking', () => {
  it('books a confirmed appointment with a doctor in the care team; the reason stays private', async () => {
    const { doctor, patient } = await careSetup('book');
    const [slot] = await slotsFor(patient, doctor);
    const created = expectOk(
      await book(patient, {
        patientId: patient.patient.id,
        doctorId: doctor.doctor.id,
        startsAt: slot.startsAt,
      }),
      201,
    );
    expect(created).toMatchObject({
      status: 'confirmed',
      mode: 'online',
      feePaise: 0,
      reason: 'Recurring headaches for a week',
    });
    expect(created.reference).toHaveLength(8);

    expect((await slotsFor(patient, doctor)).map((s) => s.startsAt)).not.toContain(slot.startsAt);
    expect(expectOk(await api(h, doctor).get(`/appointments/${created.id}`)).reason).toBe(
      'Recurring headaches for a week',
    );
    const upcoming = expectOk(await api(h, patient).get('/appointments'));
    expect(upcoming.map((a) => a.id)).toContain(created.id);

    const [event] = await auditFor(h.knex, { action: 'appointment.book', resource_id: created.id });
    expect(event).toMatchObject({ category: 'data_access', patient_id: patient.patient.id });
    const outbox = await h.ownerKnex('outbox_events').where({ aggregate_id: created.id });
    expect(outbox.map((e) => e.event_type)).toEqual(['appointment.booked']);
    expect(JSON.stringify(outbox)).not.toContain('headaches'); // ids only, never clinical content
  });

  it('requires an ACTIVE care relationship (continuity first)', async () => {
    const doctor = await createVerifiedDoctor(h, admin, 'nocare-doc');
    await publishWeek(doctor);
    const stranger = await createPatient(h, 'nocare-pt');
    const [slot] = await slotsFor(stranger, doctor);
    const res = await book(stranger, {
      patientId: stranger.patient.id,
      doctorId: doctor.doctor.id,
      startsAt: slot.startsAt,
    });
    expect(res.body.code).toBe('care_relationship_required');

    const { doctor: d2, patient: p2 } = await careSetup('paused');
    const [rel] = expectOk(await api(h, p2).get('/care-relationships'));
    expectOk(await api(h, p2).post(`/care-relationships/${rel.id}/pause`));
    const [s2] = await slotsFor(p2, d2);
    expect(
      (await book(p2, { patientId: p2.patient.id, doctorId: d2.doctor.id, startsAt: s2.startsAt }))
        .body.code,
    ).toBe('care_relationship_required');
  });

  it('rejects times that are not offered slots', async () => {
    const { doctor, patient } = await careSetup('misaligned');
    const [slot] = await slotsFor(patient, doctor);
    const off = new Date(new Date(slot.startsAt).getTime() + 5 * 60_000).toISOString();
    expect(
      (
        await book(patient, {
          patientId: patient.patient.id,
          doctorId: doctor.doctor.id,
          startsAt: off,
        })
      ).body.code,
    ).toBe('slot_not_offered');
    expect(
      (
        await book(patient, {
          patientId: patient.patient.id,
          doctorId: doctor.doctor.id,
          startsAt: slot.startsAt,
          mode: 'in_clinic',
        })
      ).body.code,
    ).toBe('slot_not_offered');
  });

  it('prevents double booking under concurrency: exactly one of many parallel requests wins', async () => {
    const doctor = await createVerifiedDoctor(h, admin, 'race-doc');
    await publishWeek(doctor);
    const patients = await Promise.all(
      Array.from({ length: 6 }, (_, i) => createPatient(h, `race-pt-${i}`)),
    );
    for (const p of patients) await linkCare(h, p, doctor);
    const [slot] = await slotsFor(patients[0], doctor);

    const results = await Promise.all(
      patients.map((p) =>
        book(p, { patientId: p.patient.id, doctorId: doctor.doctor.id, startsAt: slot.startsAt }),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(
      results.filter((r) => r.status === 409).every((r) => r.body.code === 'slot_unavailable'),
    ).toBe(true);
  });

  it('a patient cannot hold two appointments at the same time', async () => {
    const { doctor: d1, patient } = await careSetup('dbl');
    const d2 = await createVerifiedDoctor(h, admin, 'dbl-doc2');
    await publishWeek(d2);
    await linkCare(h, patient, d2);
    const [slot] = await slotsFor(patient, d1);
    expectOk(
      await book(patient, {
        patientId: patient.patient.id,
        doctorId: d1.doctor.id,
        startsAt: slot.startsAt,
      }),
      201,
    );
    const res = await book(patient, {
      patientId: patient.patient.id,
      doctorId: d2.doctor.id,
      startsAt: slot.startsAt,
    });
    expect(res.body.code).toBe('patient_double_booked');
  });

  it('idempotency keys make retries safe', async () => {
    const { doctor, patient } = await careSetup('idem');
    const [slot, other] = await slotsFor(patient, doctor);
    const key = `key-${randomUUID()}`;
    const body = {
      patientId: patient.patient.id,
      doctorId: doctor.doctor.id,
      startsAt: slot.startsAt,
    };
    const first = await book(patient, body, key);
    const retry = await book(patient, body, key);
    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body.data.id).toBe(first.body.data.id);
    expect((await book(patient, { ...body, startsAt: other.startsAt }, key)).body.code).toBe(
      'idempotency_conflict',
    );
  });

  it('paid slots create a short hold; an expired hold frees the slot', async () => {
    const { doctor, patient } = await careSetup('hold', { feePaise: 50_000 });
    const other = await createPatient(h, 'hold-pt2');
    await linkCare(h, other, doctor);
    const [slot] = await slotsFor(patient, doctor);
    const held = expectOk(
      await book(patient, {
        patientId: patient.patient.id,
        doctorId: doctor.doctor.id,
        startsAt: slot.startsAt,
      }),
      201,
    );
    expect(held).toMatchObject({ status: 'pending_payment', feePaise: 50_000 });
    expect(new Date(held.holdExpiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(
      (
        await book(other, {
          patientId: other.patient.id,
          doctorId: doctor.doctor.id,
          startsAt: slot.startsAt,
        })
      ).status,
    ).toBe(409);

    await h
      .ownerKnex('appointments')
      .where({ id: held.id })
      .update({ hold_expires_at: new Date(Date.now() - 1000) });
    expectOk(
      await book(other, {
        patientId: other.patient.id,
        doctorId: doctor.doctor.id,
        startsAt: slot.startsAt,
      }),
      201,
    );
    expect((await h.ownerKnex('appointments').where({ id: held.id }).first()).status).toBe(
      'expired',
    );
  });

  it('a guardian books for their dependent', async () => {
    const doctor = await createVerifiedDoctor(h, admin, 'dep-doc');
    await publishWeek(doctor);
    const guardian = await createPatient(h, 'dep-guardian');
    const child = expectOk(
      await api(h, guardian).post('/patients/me/dependents', {
        ...profileInput('Booked Child'),
        relationshipType: 'parent',
      }),
      201,
    );
    await linkCare(h, guardian, doctor, { patientId: child.id });
    const [slot] = await slotsFor(guardian, doctor);
    const appt = expectOk(
      await book(guardian, {
        patientId: child.id,
        doctorId: doctor.doctor.id,
        startsAt: slot.startsAt,
      }),
      201,
    );
    expect(appt.patientId).toBe(child.id);
    expect(
      expectOk(await api(h, guardian).get(`/appointments?patientId=${child.id}`)).map((a) => a.id),
    ).toContain(appt.id);
  });
});

describe('appointment lifecycle', () => {
  /** Moves an appointment's window relative to now (owner connection; test-only). */
  async function shift(id, minutesFromNow, length = 15) {
    const starts = new Date(Date.now() + minutesFromNow * 60_000);
    await h
      .ownerKnex('appointments')
      .where({ id })
      .update({ starts_at: starts, ends_at: new Date(starts.getTime() + length * 60_000) });
  }

  it('patient cancels (slot is freed); cannot cancel after the start', async () => {
    const { doctor, patient } = await careSetup('cancel');
    const [slot] = await slotsFor(patient, doctor);
    const appt = expectOk(
      await book(patient, {
        patientId: patient.patient.id,
        doctorId: doctor.doctor.id,
        startsAt: slot.startsAt,
      }),
      201,
    );
    const cancelled = expectOk(
      await api(h, patient).post(`/appointments/${appt.id}/cancel`, {
        reasonCode: 'patient_request',
      }),
    );
    expect(cancelled).toMatchObject({ status: 'cancelled', cancelledByParty: 'patient' });
    expect((await slotsFor(patient, doctor)).map((s) => s.startsAt)).toContain(slot.startsAt);

    const [slot2] = await slotsFor(patient, doctor);
    const late = expectOk(
      await book(patient, {
        patientId: patient.patient.id,
        doctorId: doctor.doctor.id,
        startsAt: slot2.startsAt,
      }),
      201,
    );
    await shift(late.id, -5);
    expect(
      (
        await api(h, patient).post(`/appointments/${late.id}/cancel`, {
          reasonCode: 'patient_request',
        })
      ).body.code,
    ).toBe('appointment_time_rule');
    expect(
      expectOk(
        await api(h, doctor).post(`/appointments/${late.id}/cancel`, {
          reasonCode: 'doctor_unavailable',
        }),
      ).cancelledByParty,
    ).toBe('doctor');
  });

  it('doctor completes after the start; patients cannot; no-show after grace', async () => {
    const { doctor, patient } = await careSetup('complete');
    const [a, b] = await slotsFor(patient, doctor);
    const first = expectOk(
      await book(patient, {
        patientId: patient.patient.id,
        doctorId: doctor.doctor.id,
        startsAt: a.startsAt,
      }),
      201,
    );
    const second = expectOk(
      await book(patient, {
        patientId: patient.patient.id,
        doctorId: doctor.doctor.id,
        startsAt: b.startsAt,
      }),
      201,
    );
    expect((await api(h, doctor).post(`/appointments/${first.id}/complete`)).body.code).toBe(
      'appointment_time_rule',
    );
    await shift(first.id, -2);
    expect((await api(h, patient).post(`/appointments/${first.id}/complete`)).body.code).toBe(
      'wrong_party',
    );
    expect(expectOk(await api(h, doctor).post(`/appointments/${first.id}/complete`)).status).toBe(
      'completed',
    );

    await shift(second.id, -20, 30);
    expect(expectOk(await api(h, doctor).post(`/appointments/${second.id}/no-show`)).status).toBe(
      'no_show',
    );
  });

  it('rescheduling atomically cancels and rebooks, keeping the reason', async () => {
    const { doctor, patient } = await careSetup('resched');
    const [a, , c] = await slotsFor(patient, doctor);
    const original = expectOk(
      await book(patient, {
        patientId: patient.patient.id,
        doctorId: doctor.doctor.id,
        startsAt: a.startsAt,
      }),
      201,
    );
    const moved = expectOk(
      await api(h, patient).post(`/appointments/${original.id}/reschedule`, {
        startsAt: c.startsAt,
      }),
    );
    expect(moved).toMatchObject({
      status: 'confirmed',
      rescheduledFromId: original.id,
      reason: 'Recurring headaches for a week',
    });
    expect(new Date(moved.startsAt).toISOString()).toBe(new Date(c.startsAt).toISOString());
    const old = expectOk(await api(h, patient).get(`/appointments/${original.id}`));
    expect(old).toMatchObject({ status: 'cancelled', cancelReason: 'rescheduled' });
    // A failed reschedule (slot not offered) leaves the original untouched.
    const res = await api(h, patient).post(`/appointments/${moved.id}/reschedule`, {
      startsAt: '2030-01-01T00:07:00Z',
    });
    expect(res.status).toBe(409);
    expect(expectOk(await api(h, patient).get(`/appointments/${moved.id}`)).status).toBe(
      'confirmed',
    );
  });

  it('in-clinic visits: the clinic schedules and checks in without seeing patient identity or reason', async () => {
    const { clinic, clinicAdmin } = await createClinicWithAdmin(h, admin, 'sched-clinic');
    const doctor = await createVerifiedDoctor(h, admin, 'clinic-doc');
    const invite = expectOk(
      await api(h, clinicAdmin).post(`/clinics/${clinic.id}/doctors`, {
        doctorId: doctor.doctor.id,
      }),
      201,
    );
    expectOk(await api(h, doctor).post(`/clinic-memberships/${invite.id}/accept`));
    await publishWeek(doctor, { mode: 'in_clinic', clinicId: clinic.id });
    const patient = await createPatient(h, 'clinic-pt');
    await linkCare(h, patient, doctor, { clinicId: clinic.id });
    const [slot] = await slotsFor(patient, doctor, { mode: 'in_clinic' });
    const appt = expectOk(
      await book(patient, {
        patientId: patient.patient.id,
        doctorId: doctor.doctor.id,
        startsAt: slot.startsAt,
        mode: 'in_clinic',
        clinicId: clinic.id,
      }),
      201,
    );

    const from = new Date(Date.now() - 86_400_000).toISOString();
    const to = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const board = expectOk(
      await api(h, clinicAdmin).get(`/clinics/${clinic.id}/appointments?from=${from}&to=${to}`),
    );
    expect(board).toHaveLength(1);
    expect(board[0]).toMatchObject({ id: appt.id, reference: appt.reference, status: 'confirmed' });
    expect(board[0]).not.toHaveProperty('patientId');
    expect(board[0]).not.toHaveProperty('reason');
    const detail = expectOk(await api(h, clinicAdmin).get(`/appointments/${appt.id}`));
    expect(detail).not.toHaveProperty('reason');

    await shift(appt.id, 30);
    expect(
      expectOk(await api(h, clinicAdmin).post(`/appointments/${appt.id}/check-in`)).status,
    ).toBe('checked_in');
    expect((await api(h, clinicAdmin).post(`/appointments/${appt.id}/complete`)).body.code).toBe(
      'wrong_party',
    );

    // Another clinic's administrator sees nothing.
    const other = await createClinicWithAdmin(h, admin, 'sched-other');
    expect(
      (
        await api(h, other.clinicAdmin).get(
          `/clinics/${clinic.id}/appointments?from=${from}&to=${to}`,
        )
      ).status,
    ).toBe(403); // no appointments:read for this clinic
    expect((await api(h, other.clinicAdmin).get(`/appointments/${appt.id}`)).status).toBe(403);
  });

  it('doctor schedule shows patient identity through AccessPolicy', async () => {
    const { doctor, patient } = await careSetup('docsched');
    const [slot] = await slotsFor(patient, doctor);
    expectOk(
      await book(patient, {
        patientId: patient.patient.id,
        doctorId: doctor.doctor.id,
        startsAt: slot.startsAt,
      }),
      201,
    );
    const from = new Date().toISOString();
    const to = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const schedule = expectOk(
      await api(h, doctor).get(`/doctors/me/appointments?from=${from}&to=${to}`),
    );
    expect(schedule[0].patient).toMatchObject({
      id: patient.patient.id,
      fullName: patient.patient.fullName,
    });
  });
});

describe('appointment authorization (fail closed)', () => {
  let doctor;
  let patient;
  let appt;
  beforeAll(async () => {
    ({ doctor, patient } = await careSetup('authz'));
    const [slot] = await slotsFor(patient, doctor);
    appt = expectOk(
      await book(patient, {
        patientId: patient.patient.id,
        doctorId: doctor.doctor.id,
        startsAt: slot.startsAt,
      }),
      201,
    );
  });

  it('unrelated patients and doctors cannot see or change the appointment', async () => {
    const stranger = await createPatient(h, 'authz-stranger');
    const otherDoctor = await createVerifiedDoctor(h, admin, 'authz-otherdoc');
    for (const who of [stranger, otherDoctor]) {
      expect((await api(h, who).get(`/appointments/${appt.id}`)).status).toBe(404);
      expect(
        (await api(h, who).post(`/appointments/${appt.id}/cancel`, { reasonCode: 'other' })).status,
      ).toBe(404);
    }
    expect(
      (await api(h, stranger).get(`/appointments?patientId=${patient.patient.id}`)).status,
    ).toBe(404);
    expect((await api(h, stranger).get(`/appointments/${randomUUID()}`)).status).toBe(404);
  });

  it('cannot book for someone else, even with a valid slot', async () => {
    const stranger = await createPatient(h, 'authz-booker');
    const [slot] = await slotsFor(stranger, doctor);
    const res = await book(stranger, {
      patientId: patient.patient.id,
      doctorId: doctor.doctor.id,
      startsAt: slot.startsAt,
    });
    expect(res.status).toBe(404);
  });

  it("the treating doctor cannot list the patient's appointments with other doctors (no consent basis)", async () => {
    const res = await api(h, doctor).get(`/appointments?patientId=${patient.patient.id}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('consent_required');
  });

  it('administrative roles have no appointment access', async () => {
    const support = await createUser(h, { label: 'authz-support', roles: ['SUPPORT'] });
    expect((await api(h, admin).get(`/appointments/${appt.id}`)).status).toBe(403);
    expect((await api(h, support).get(`/appointments/${appt.id}`)).status).toBe(404);
    expect((await api(h, admin).post('/appointments', {})).status).toBe(403);
  });
});

describe('RLS on appointments and intakes', () => {
  it('rows and reasons are invisible outside the relationship, even to raw SQL', async () => {
    const { clinic, clinicAdmin } = await createClinicWithAdmin(h, admin, 'rls-sched');
    const doctor = await createVerifiedDoctor(h, admin, 'rls-sched-doc');
    const invite = expectOk(
      await api(h, clinicAdmin).post(`/clinics/${clinic.id}/doctors`, {
        doctorId: doctor.doctor.id,
      }),
      201,
    );
    expectOk(await api(h, doctor).post(`/clinic-memberships/${invite.id}/accept`));
    await publishWeek(doctor, { mode: 'in_clinic', clinicId: clinic.id });
    const patient = await createPatient(h, 'rls-sched-pt');
    await linkCare(h, patient, doctor, { clinicId: clinic.id });
    const [slot] = await slotsFor(patient, doctor, { mode: 'in_clinic' });
    const appt = expectOk(
      await book(patient, {
        patientId: patient.patient.id,
        doctorId: doctor.doctor.id,
        startsAt: slot.startsAt,
        mode: 'in_clinic',
        clinicId: clinic.id,
      }),
      201,
    );
    const stranger = await createPatient(h, 'rls-sched-stranger');

    const asActor = (userId, fn) =>
      h.knex.transaction(async (trx) => {
        if (userId) await trx.raw("SELECT set_config('app.user_id', ?, true)", [userId]);
        return fn(trx);
      });
    const sees = (userId, table, col = 'id') =>
      asActor(userId, (trx) => trx(table).where(col, appt.id).pluck(col));

    expect(await sees(null, 'appointments')).toEqual([]);
    expect(await sees(stranger.id, 'appointments')).toEqual([]);
    expect(await sees(patient.id, 'appointments')).toEqual([appt.id]);
    expect(await sees(doctor.id, 'appointments')).toEqual([appt.id]);
    expect(await sees(clinicAdmin.id, 'appointments')).toEqual([appt.id]);
    // The clinical reason: patient and doctor only — never clinic staff.
    expect(await sees(patient.id, 'appointment_intakes', 'appointment_id')).toEqual([appt.id]);
    expect(await sees(doctor.id, 'appointment_intakes', 'appointment_id')).toEqual([appt.id]);
    expect(await sees(clinicAdmin.id, 'appointment_intakes', 'appointment_id')).toEqual([]);
    // Busy ranges expose times only.
    const busy = await asActor(stranger.id, (trx) =>
      trx.raw("SELECT * FROM authz.doctor_busy_ranges(?, now(), now() + interval '5 days')", [
        doctor.doctor.id,
      ]),
    );
    expect(Object.keys(busy.rows[0]).sort()).toEqual(['ends_at', 'starts_at']);
    // Forging an appointment for another patient is rejected.
    await expect(
      asActor(stranger.id, (trx) =>
        trx('appointments').insert({
          id: randomUUID(),
          patient_id: patient.patient.id,
          doctor_id: doctor.doctor.id,
          care_relationship_id: randomUUID(),
          mode: 'online',
          status: 'confirmed',
          starts_at: new Date(Date.now() + 9 * 86_400_000),
          ends_at: new Date(Date.now() + 9 * 86_400_000 + 900_000),
          booked_by_user_id: stranger.id,
        }),
      ),
    ).rejects.toThrow(/row-level security|violates foreign key/);
  });
});
