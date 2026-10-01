// Row-level security tested on its own: raw SQL as the application role, no AccessPolicy,
// no services. Proves the database enforces patient boundaries even if application code
// were wrong (defence in depth, ADR-0017).

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

let h;
let patientA;
let patientB;
let doctorA;
let doctorB;
let guardian;
let dependent;
let clinic;

beforeAll(async () => {
  h = await createHarness();
  const admin = await createPlatformAdmin(h);
  patientA = await createPatient(h, 'rls-a');
  patientB = await createPatient(h, 'rls-b');
  doctorA = await createVerifiedDoctor(h, admin, 'rls-doc-a');
  doctorB = await createVerifiedDoctor(h, admin, 'rls-doc-b');
  guardian = await createPatient(h, 'rls-guardian');
  dependent = expectOk(
    await api(h, guardian).post('/patients/me/dependents', {
      ...profileInput('RLS Child'),
      relationshipType: 'parent',
    }),
    201,
  );
  clinic = await createClinicWithAdmin(h, admin, 'rls-clinic');
  await linkCare(h, patientA, doctorA);
});
afterAll(async () => {
  await h.close();
});

/** Runs `fn` as the application DB role with `app.user_id` set (or unset). */
function asActor(userId, fn) {
  return h.knex.transaction(async (trx) => {
    if (userId !== undefined) await trx.raw("SELECT set_config('app.user_id', ?, true)", [userId]);
    return fn(trx);
  });
}
const visiblePatients = (userId) => asActor(userId, (trx) => trx('patients').pluck('id'));

describe('RLS on patients', () => {
  it('no actor context: nothing is visible', async () => {
    expect(await h.knex('patients').count({ n: '*' }).first()).toEqual({ n: '0' });
    expect(await visiblePatients(undefined)).toEqual([]);
    expect(await asActor('', (trx) => trx('patients').pluck('id'))).toEqual([]);
    expect(await asActor("x' OR 1=1 --", (trx) => trx('patients').pluck('id'))).toEqual([]);
  });

  it('patient A sees only their own profile, never patient B', async () => {
    expect(await visiblePatients(patientA.id)).toEqual([patientA.patient.id]);
    expect(await visiblePatients(patientB.id)).toEqual([patientB.patient.id]);
  });

  it('a treating doctor sees their patient; an unrelated doctor sees nobody', async () => {
    expect(await visiblePatients(doctorA.id)).toContain(patientA.patient.id);
    expect(await visiblePatients(doctorA.id)).not.toContain(patientB.patient.id);
    expect(await visiblePatients(doctorB.id)).toEqual([]);
  });

  it('a guardian sees their dependent; other users do not', async () => {
    expect(await visiblePatients(guardian.id)).toEqual(
      expect.arrayContaining([guardian.patient.id, dependent.id]),
    );
    expect(await visiblePatients(patientA.id)).not.toContain(dependent.id);
  });

  it('clinic membership alone grants no visibility', async () => {
    expect(await visiblePatients(clinic.clinicAdmin.id)).toEqual([]);
  });

  it('writes outside the actor scope affect no rows', async () => {
    const updated = await asActor(patientA.id, (trx) =>
      trx('patients').where({ id: patientB.patient.id }).update({ city: 'Hijacked' }),
    );
    expect(updated).toBe(0);
    const deleted = await asActor(patientA.id, (trx) =>
      trx('patients').where({ id: patientA.patient.id }).del(),
    );
    expect(deleted).toBe(0); // no DELETE policy: even own rows cannot be deleted
  });

  it('cannot insert a profile owned by someone else', async () => {
    await expect(
      asActor(patientA.id, (trx) =>
        trx('patients').insert({
          id: randomUUID(),
          user_id: patientB.id,
          created_by_user_id: patientB.id,
          full_name: 'Spoofed',
          date_of_birth: '1990-01-01',
        }),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('a doctor with an ended relationship loses visibility', async () => {
    const patient = await createPatient(h, 'rls-ended');
    const rel = await linkCare(h, patient, doctorB);
    expect(await visiblePatients(doctorB.id)).toContain(patient.patient.id);
    expectOk(await api(h, patient).post(`/care-relationships/${rel.id}/end`));
    expect(await visiblePatients(doctorB.id)).not.toContain(patient.patient.id);
  });

  it('the actor setting is transaction-local and never leaks across pooled connections', async () => {
    await asActor(patientA.id, async () => {});
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        h.knex.raw("SELECT current_setting('app.user_id', true) AS v"),
      ),
    );
    for (const r of results) expect(r.rows[0].v || null).toBeNull();
  });
});

describe('RLS on guardianships and care relationships', () => {
  it('guardianships are visible only to the guardian and the patient themself', async () => {
    const forGuardian = await asActor(guardian.id, (trx) =>
      trx('patient_guardianships').pluck('patient_id'),
    );
    expect(forGuardian).toContain(dependent.id);
    expect(await asActor(patientA.id, (trx) => trx('patient_guardianships').pluck('id'))).toEqual(
      [],
    );
  });

  it('a guardianship for a patient the actor did not create cannot be inserted', async () => {
    await expect(
      asActor(patientA.id, (trx) =>
        trx('patient_guardianships').insert({
          id: randomUUID(),
          patient_id: patientB.patient.id,
          guardian_user_id: patientA.id,
          relationship_type: 'spouse',
          access_scope: 'manage',
          basis: 'created_dependent',
          status: 'active',
          started_at: new Date(),
          created_by_user_id: patientA.id,
        }),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('care relationships are visible to their two parties only', async () => {
    const forPatient = await asActor(patientA.id, (trx) =>
      trx('care_relationships').pluck('doctor_id'),
    );
    expect(forPatient).toContain(doctorA.doctor.id);
    expect(
      await asActor(patientB.id, (trx) =>
        trx('care_relationships').where({ patient_id: patientA.patient.id }).pluck('id'),
      ),
    ).toEqual([]);
    expect(
      await asActor(doctorB.id, (trx) =>
        trx('care_relationships').where({ patient_id: patientA.patient.id }).pluck('id'),
      ),
    ).toEqual([]);
  });

  it('a doctor cannot forge an ACTIVE relationship on behalf of a patient', async () => {
    await expect(
      asActor(doctorB.id, (trx) =>
        trx('care_relationships').insert({
          id: randomUUID(),
          patient_id: patientB.patient.id,
          doctor_id: doctorB.doctor.id,
          status: 'active',
          initiated_by: 'patient', // pretending the patient asked
          requested_by_user_id: doctorB.id,
          activated_at: new Date(),
        }),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});

describe('RLS configuration', () => {
  it('is enabled on every patient-scoped table, and the app role cannot bypass it', async () => {
    const { rows } = await h.ownerKnex.raw(
      `SELECT relname, relrowsecurity FROM pg_class
        WHERE relname IN ('patients', 'patient_guardianships', 'care_relationships') ORDER BY relname`,
    );
    expect(rows.every((r) => r.relrowsecurity)).toBe(true);
    const { rows: role } = await h.knex.raw(
      'SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user',
    );
    expect(role[0].rolbypassrls).toBe(false);
  });
});
