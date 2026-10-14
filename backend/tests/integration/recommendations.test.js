import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness } from './harness.js';
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

/**
 * M13.3 recommendations: a few doctors, ranked with what the patient side may already
 * see (care team, past visits, the profile's city and language, the soonest free time),
 * each with grounded explanations and a next step. Never a medical judgement.
 */
let h;
let admin;
beforeAll(async () => {
  h = await createHarness();
  admin = await createPlatformAdmin(h, 'rec-admin');
});
afterAll(async () => {
  await h.close();
});

const isoDate = (offsetDays) =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
const letters = () =>
  Array.from({ length: 8 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join(
    '',
  );

async function publishOnline(doctor) {
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    expectOk(
      await api(h, doctor).post('/doctors/me/availability', {
        mode: 'online',
        weekday,
        startTime: '14:00',
        endTime: '18:00',
        slotMinutes: 15,
        validFrom: isoDate(-1),
      }),
      201,
    );
  }
}

describe('GET /patients/:id/recommendations', () => {
  let tag;
  let patient;
  let seen;
  let local;
  let marathi;
  let pending;
  beforeAll(async () => {
    tag = letters();
    const make = async (role, profile, setup) => {
      const doctor = await createVerifiedDoctor(h, admin, `rec-${tag}-${role}`);
      expectOk(
        await api(h, doctor).patch('/doctors/me', {
          primarySpecialization: 'Cardiology',
          ...profile,
        }),
      );
      if (setup) await setup(doctor);
      await publishOnline(doctor);
      return doctor;
    };
    seen = await make('seen', { languages: ['English'] });
    local = await make('local', { languages: ['English'] }, async (doctor) => {
      const pune = await createClinicWithAdmin(h, admin, `rec-${tag}`);
      const invite = expectOk(
        await api(h, pune.clinicAdmin).post(`/clinics/${pune.clinic.id}/doctors`, {
          doctorId: doctor.doctor.id,
        }),
        201,
      );
      expectOk(await api(h, doctor).post(`/clinic-memberships/${invite.id}/accept`));
    });
    marathi = await make('marathi', { languages: ['English', 'Marathi'] });
    pending = await make('pending', { languages: ['English'] });

    patient = await createPatient(h, `rec-${tag}-pt`);
    expectOk(
      await api(h, patient).patch(`/patients/${patient.patient.id}`, {
        preferredLanguage: 'mr-IN',
      }),
    );
    // Continuity: an active relationship and a completed visit 10 days ago.
    const relationship = await linkCare(h, patient, seen);
    const starts = new Date(Date.now() - 10 * 86_400_000);
    await h.ownerKnex('appointments').insert({
      id: randomUUID(),
      patient_id: patient.patient.id,
      doctor_id: seen.doctor.id,
      care_relationship_id: relationship.id,
      mode: 'online',
      status: 'completed',
      starts_at: starts,
      ends_at: new Date(starts.getTime() + 15 * 60_000),
      fee_paise: 0,
      booked_by_user_id: patient.id,
      confirmed_at: starts,
      completed_at: starts,
    });
    // A request the doctor has not answered yet.
    expectOk(
      await api(h, patient).post('/care-relationships', {
        patientId: patient.patient.id,
        doctorId: pending.doctor.id,
      }),
      201,
    );
  });

  const recommend = (who, patientId, query) =>
    api(h, who).get(`/patients/${patientId}/recommendations?${new URLSearchParams(query)}`);

  it('ranks with continuity and preferences, explains each one, and gives the next step', async () => {
    const res = recommend(patient, patient.patient.id, {
      specialty: 'Cardiology',
      name: `rec-${tag}`,
      limit: '5',
    });
    const list = expectOk(await res);
    expect(list.map((r) => r.doctor.id)).toHaveLength(4);
    const by = Object.fromEntries(list.map((r) => [r.doctor.id, r]));
    const codes = (d) => by[d.doctor.id].explanations.map((e) => e.code);

    // Seen before and in the care team: first, and bookable now.
    expect(list[0].doctor.id).toBe(seen.doctor.id);
    expect(codes(seen)).toEqual(expect.arrayContaining(['seen_before', 'care_team']));
    expect(by[seen.doctor.id].nextStep.type).toBe('book');
    expect(by[seen.doctor.id].nextStep.startsAt).toEqual(expect.any(String));
    // Profile city (Pune) and preferred language (mr-IN → Marathi) lift without filtering.
    expect(by[local.doctor.id].explanations).toContainEqual({ code: 'near_you', value: 'Pune' });
    expect(by[marathi.doctor.id].explanations).toContainEqual({
      code: 'speaks_your_language',
      value: 'Marathi',
    });
    expect(list.at(-1).doctor.id).toBe(pending.doctor.id);
    // Next steps follow the care relationship.
    expect(by[local.doctor.id].nextStep).toEqual({ type: 'request_care' });
    expect(by[pending.doctor.id].nextStep).toEqual({ type: 'await_acceptance' });
    // Every recommendation says why, with the search match and the soonest free time.
    for (const r of list) {
      expect(r.explanations.map((e) => e.code)).toContain('matches_specialty');
      expect(r.explanations.find((e) => e.code === 'earliest')).toMatchObject({ mode: 'online' });
    }
    // Explanations are facts (codes and values), never health statements.
    expect(JSON.stringify(list)).not.toMatch(/diagnos|symptom|condition|treat/i);
  });

  it('says when nobody matches', async () => {
    const res = await recommend(patient, patient.patient.id, {
      specialty: 'Neurology',
      name: `rec-${tag}`,
    });
    expect(expectOk(res)).toEqual([]);
    expect(res.body.meta.status).toBe('no_match');
  });

  it('is for the patient side only: a guardian yes; another patient or a doctor no', async () => {
    const guardian = await createPatient(h, `rec-${tag}-guardian`);
    const dependent = expectOk(
      await api(h, guardian).post('/patients/me/dependents', {
        ...profileInput('Rec Child'),
        relationshipType: 'parent',
      }),
      201,
    );
    expect((await recommend(guardian, dependent.id, { specialty: 'Cardiology' })).status).toBe(200);

    const stranger = await createPatient(h, `rec-${tag}-stranger`);
    expect([403, 404]).toContain(
      (await recommend(stranger, patient.patient.id, { specialty: 'Cardiology' })).status,
    );
    // The treating doctor may read the profile with consent, but recommendations are the
    // patient's own choice.
    expectOk(
      await api(h, patient).post('/consents', {
        patientId: patient.patient.id,
        doctorId: seen.doctor.id,
        kind: 'manual',
        scopes: ['patient_profile'],
        purpose: 'ongoing_care',
        expiresInDays: 30,
      }),
      201,
    );
    expect((await recommend(seen, patient.patient.id, { specialty: 'Cardiology' })).status).toBe(
      403,
    );
  });

  it('refuses unknown criteria', async () => {
    for (const query of [{ specialty: 'Astrology' }, { areas: 'bogus' }, { limit: '50' }]) {
      expect((await recommend(patient, patient.patient.id, query)).status).toBe(400);
    }
  });
});
