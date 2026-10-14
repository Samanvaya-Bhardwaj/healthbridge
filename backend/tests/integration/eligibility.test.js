import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { withActor } from '../../src/core/db/actorContext.js';
import { authHeader, createHarness } from './harness.js';
import {
  api,
  createClinicWithAdmin,
  createPatient,
  createPlatformAdmin,
  createVerifiedDoctor,
  expectOk,
  linkCare,
} from './m2fixtures.js';

/**
 * Step 4: one eligibility rule for search, slots and booking (migration
 * 20261015000000_practice_eligibility). A doctor is bookable while the profile is active
 * and verified and the account is active; a clinic is a practice site while it is active
 * and the doctor's membership there is active. The database guards every booking under
 * row locks, and future bookings that stop being eligible are withdrawn by the system.
 */
let h;
let admin;
beforeAll(async () => {
  h = await createHarness();
  admin = await createPlatformAdmin(h, 'elig-admin');
});
afterAll(async () => {
  await h.close();
});

const isoDate = (offsetDays) =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Windows of one doctor may not overlap, whatever the mode. */
async function publishWeek(doctor, { mode = 'online', clinicId, startTime, endTime } = {}) {
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    expectOk(
      await api(h, doctor).post('/doctors/me/availability', {
        mode,
        ...(clinicId ? { clinicId } : {}),
        weekday,
        startTime,
        endTime,
        slotMinutes: 15,
        validFrom: isoDate(-1),
        feePaise: 0,
      }),
      201,
    );
  }
}
const slotsRes = (who, doctor, query = {}) =>
  api(h, who).get(
    `/doctors/${doctor.doctor.id}/slots?${new URLSearchParams({ from: isoDate(1), to: isoDate(2), ...query })}`,
  );
const book = (who, body) =>
  request(h.app)
    .post('/api/v1/appointments')
    .set(authHeader(who.session))
    .send({ mode: 'online', reason: 'Recurring headaches for a week', ...body });
const appointment = (id) => h.ownerKnex('appointments').where({ id }).first();
const outbox = (eventType) => h.ownerKnex('outbox_events').where({ event_type: eventType });

/** A doctor practising online and at one clinic, with a patient in their care team. */
async function practice(label) {
  const { clinic, clinicAdmin } = await createClinicWithAdmin(h, admin, `${label}-clinic`);
  const doctor = await createVerifiedDoctor(h, admin, `${label}-doc`);
  const invite = expectOk(
    await api(h, clinicAdmin).post(`/clinics/${clinic.id}/doctors`, {
      doctorId: doctor.doctor.id,
    }),
    201,
  );
  expectOk(await api(h, doctor).post(`/clinic-memberships/${invite.id}/accept`));
  await publishWeek(doctor, {
    mode: 'in_clinic',
    clinicId: clinic.id,
    startTime: '06:00',
    endTime: '14:00',
  });
  await publishWeek(doctor, { mode: 'online', startTime: '14:00', endTime: '22:00' });
  const patient = await createPatient(h, `${label}-pt`);
  await linkCare(h, patient, doctor, { clinicId: clinic.id });
  return { clinic, clinicAdmin, doctor, patient, membershipId: invite.id };
}

async function bookFirst(p, mode, index = 0) {
  const slots = expectOk(await slotsRes(p.patient, p.doctor, { mode }));
  const slot = slots[index];
  return expectOk(
    await book(p.patient, {
      patientId: p.patient.patient.id,
      doctorId: p.doctor.doctor.id,
      startsAt: slot.startsAt,
      mode,
      ...(mode === 'in_clinic' ? { clinicId: p.clinic.id } : {}),
    }),
    201,
  );
}

/** A raw appointment row like one the booking service writes, for the database guard. */
async function rawRowLike(appointmentId, daysLater) {
  const a = await appointment(appointmentId);
  const starts = new Date(a.starts_at.getTime() + daysLater * 86_400_000);
  return {
    id: randomUUID(),
    patient_id: a.patient_id,
    doctor_id: a.doctor_id,
    clinic_id: a.clinic_id,
    availability_rule_id: a.availability_rule_id,
    care_relationship_id: a.care_relationship_id,
    mode: a.mode,
    status: 'confirmed',
    starts_at: starts,
    ends_at: new Date(starts.getTime() + 15 * 60_000),
    fee_paise: 0,
    booked_by_user_id: a.booked_by_user_id,
    confirmed_at: new Date(),
  };
}

describe('one eligibility rule for the directory, slots and booking', () => {
  it('a disabled doctor account leaves the directory, slots and booking at once', async () => {
    const p = await practice('elig-disabled');
    const booked = await bookFirst(p, 'online');

    expectOk(
      await api(h, admin).patch(`/admin/users/${p.doctor.id}/status`, {
        status: 'disabled',
        reasonCode: 'security_concern',
      }),
    );
    const directory = expectOk(
      await api(h, p.patient).get(`/doctors?q=${encodeURIComponent('elig-disabled-doc')}`),
    );
    expect(directory.map((d) => d.id)).not.toContain(p.doctor.doctor.id);
    expect((await api(h, p.patient).get(`/doctors/${p.doctor.doctor.id}`)).status).toBe(404);
    expect((await slotsRes(p.patient, p.doctor)).status).toBe(404);
    const refused = await book(p.patient, {
      patientId: p.patient.patient.id,
      doctorId: p.doctor.doctor.id,
      startsAt: booked.startsAt,
      mode: 'online',
    });
    expect(refused.status).toBe(404);

    // The change is recorded for the clean-up, which withdraws the future booking.
    const changes = await outbox('practice.changed').where({ aggregate_id: p.doctor.id });
    expect(changes.map((e) => e.payload)).toEqual([
      { userId: p.doctor.id, cause: 'account_disabled' },
    ]);
    const doctorId = await h.container.doctorService.doctorIdForUser(p.doctor.id);
    expect(await h.container.appointmentService.withdrawIneligible({ doctorId })).toEqual({
      withdrawn: 1,
    });
    expect(await appointment(booked.id)).toMatchObject({
      status: 'cancelled',
      cancelled_by_party: 'system',
      cancel_reason: 'doctor_unavailable',
      cancelled_by_user_id: null,
    });
    const cancelled = await outbox('appointment.cancelled').where({ aggregate_id: booked.id });
    expect(cancelled[0].payload).toMatchObject({ party: 'system', reason: 'doctor_unavailable' });
    // Idempotent: nothing left to withdraw.
    expect(await h.container.appointmentService.withdrawIneligible({ doctorId })).toEqual({
      withdrawn: 0,
    });
  });

  it('a closed clinic stops its in-clinic slots and bookings; online practice continues', async () => {
    const p = await practice('elig-closed');
    const atClinic = await bookFirst(p, 'in_clinic');
    const online = await bookFirst(p, 'online', 3);

    expectOk(
      await api(h, admin).patch(`/admin/clinics/${p.clinic.id}/status`, { status: 'inactive' }),
    );
    expect(expectOk(await slotsRes(p.patient, p.doctor, { mode: 'in_clinic' }))).toEqual([]);
    expect(
      expectOk(await slotsRes(p.patient, p.doctor, { mode: 'online' })).length,
    ).toBeGreaterThan(0);
    // The doctor still sees (and can archive) the rules at the closed clinic, marked.
    const rules = expectOk(await api(h, p.doctor).get('/doctors/me/availability'));
    const inClinic = rules.filter((r) => r.mode === 'in_clinic');
    expect(inClinic).toHaveLength(7);
    expect(inClinic.every((r) => r.bookable === false)).toBe(true);
    expect(rules.filter((r) => r.mode === 'online').every((r) => r.bookable === true)).toBe(true);
    const refused = await book(p.patient, {
      patientId: p.patient.patient.id,
      doctorId: p.doctor.doctor.id,
      startsAt: atClinic.startsAt,
      mode: 'in_clinic',
      clinicId: p.clinic.id,
    });
    expect(refused.status).toBe(409);

    const changes = await outbox('practice.changed').where({ aggregate_id: p.clinic.id });
    expect(changes.map((e) => e.payload)).toEqual([
      { clinicId: p.clinic.id, cause: 'clinic_closed' },
    ]);
    expect(
      await h.container.appointmentService.withdrawIneligible({ clinicId: p.clinic.id }),
    ).toEqual({ withdrawn: 1 });
    expect(await appointment(atClinic.id)).toMatchObject({
      status: 'cancelled',
      cancelled_by_party: 'system',
      cancel_reason: 'clinic_closed',
    });
    expect((await appointment(online.id)).status).toBe('confirmed');
  });

  it('a doctor who leaves a clinic: bookings there are withdrawn, others stay', async () => {
    const p = await practice('elig-left');
    const atClinic = await bookFirst(p, 'in_clinic');
    const online = await bookFirst(p, 'online', 3);

    expectOk(
      await api(h, p.clinicAdmin).post(`/clinics/${p.clinic.id}/members/${p.membershipId}/end`),
    );
    expect(expectOk(await slotsRes(p.patient, p.doctor, { mode: 'in_clinic' }))).toEqual([]);
    const changes = await outbox('practice.changed').where({ aggregate_id: p.doctor.doctor.id });
    expect(changes.map((e) => e.payload)).toEqual([
      { doctorId: p.doctor.doctor.id, clinicId: p.clinic.id, cause: 'membership_ended' },
    ]);
    expect(
      await h.container.appointmentService.withdrawIneligible({
        doctorId: p.doctor.doctor.id,
        clinicId: p.clinic.id,
      }),
    ).toEqual({ withdrawn: 1 });
    expect(await appointment(atClinic.id)).toMatchObject({
      status: 'cancelled',
      cancel_reason: 'doctor_unavailable',
    });
    expect((await appointment(online.id)).status).toBe('confirmed');
  });

  it('a suspended doctor: future bookings are withdrawn, the change is recorded', async () => {
    const p = await practice('elig-suspended');
    const booked = await bookFirst(p, 'online');
    expectOk(
      await api(h, admin).post(`/admin/doctors/${p.doctor.doctor.id}/suspend`, {
        reasonCode: 'misconduct_report',
      }),
    );
    const changes = await outbox('practice.changed').where({ aggregate_id: p.doctor.doctor.id });
    expect(changes.map((e) => e.payload.cause)).toEqual(['doctor_suspended']);
    await h.container.appointmentService.withdrawIneligible({ doctorId: p.doctor.doctor.id });
    expect((await appointment(booked.id)).cancel_reason).toBe('doctor_unavailable');
  });
});

describe('the database is the final authority at booking time', () => {
  it('refuses an ineligible booking even when the application check is bypassed', async () => {
    const p = await practice('elig-guard');
    const atClinic = await bookFirst(p, 'in_clinic');
    expectOk(
      await api(h, admin).patch(`/admin/clinics/${p.clinic.id}/status`, { status: 'inactive' }),
    );
    const closedSite = await rawRowLike(atClinic.id, 3);
    await expect(
      withActor(h.knex, p.patient.id, (trx) => trx('appointments').insert(closedSite)),
    ).rejects.toMatchObject({ constraint: 'appointments_practice_site_open' });

    await h.ownerKnex('users').where({ id: p.doctor.id }).update({ status: 'disabled' });
    const disabledDoctor = { ...(await rawRowLike(atClinic.id, 4)), clinic_id: null };
    disabledDoctor.mode = 'online';
    disabledDoctor.availability_rule_id = null;
    await expect(
      withActor(h.knex, p.patient.id, (trx) => trx('appointments').insert(disabledDoctor)),
    ).rejects.toMatchObject({ constraint: 'appointments_doctor_bookable' });
  });

  it('a clinic closure waits for a booking in flight, so the clean-up sees it', async () => {
    const p = await practice('elig-race');
    const first = await bookFirst(p, 'in_clinic');
    const row = await rawRowLike(first.id, 2);

    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let inserted = false;
    const booking = withActor(h.knex, p.patient.id, async (trx) => {
      await trx('appointments').insert(row);
      inserted = true;
      await gate; // the booking transaction stays open, holding its FOR SHARE locks
    });
    while (!inserted) await sleep(10);

    const closing = api(h, admin)
      .patch(`/admin/clinics/${p.clinic.id}/status`, { status: 'inactive' })
      .then((res) => res);
    expect(
      await Promise.race([closing.then(() => 'closed'), sleep(700).then(() => 'waiting')]),
    ).toBe('waiting');
    release();
    await booking;
    expect((await closing).status).toBe(200);

    // The booking committed first, so the clean-up after the closure withdraws it.
    await h.container.appointmentService.withdrawIneligible({ clinicId: p.clinic.id });
    expect(await appointment(row.id)).toMatchObject({
      status: 'cancelled',
      cancel_reason: 'clinic_closed',
    });
    // After the closure, a booking is refused.
    const after = await rawRowLike(first.id, 5);
    await expect(
      withActor(h.knex, p.patient.id, (trx) => trx('appointments').insert(after)),
    ).rejects.toMatchObject({ constraint: 'appointments_practice_site_open' });
  });

  it('concurrent bookings and a closure never leave an open booking at a closed clinic', async () => {
    const p = await practice('elig-many');
    const slots = expectOk(await slotsRes(p.patient, p.doctor, { mode: 'in_clinic' }));
    const attempts = slots.slice(0, 6).map((slot) =>
      book(p.patient, {
        patientId: p.patient.patient.id,
        doctorId: p.doctor.doctor.id,
        startsAt: slot.startsAt,
        mode: 'in_clinic',
        clinicId: p.clinic.id,
      }).then((res) => res),
    );
    const closure = api(h, admin)
      .patch(`/admin/clinics/${p.clinic.id}/status`, { status: 'inactive' })
      .then((res) => res);
    const results = await Promise.all([...attempts, closure]);
    expect(results.at(-1).status).toBe(200);
    for (const res of results.slice(0, -1)) expect([201, 409]).toContain(res.status);

    await h.container.appointmentService.withdrawIneligible({ clinicId: p.clinic.id });
    const open = await h
      .ownerKnex('appointments')
      .where({ clinic_id: p.clinic.id })
      .whereIn('status', ['pending_payment', 'confirmed'])
      .where('starts_at', '>', new Date());
    expect(open).toEqual([]);
  });
});
