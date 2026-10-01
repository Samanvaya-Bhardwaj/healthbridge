import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditFor, createHarness, createUser, login } from './harness.js';
import { withActor } from '../../src/core/db/actorContext.js';
import { createAccessPolicy } from '../../src/core/authz/accessPolicy.js';
import { createCareAccess } from '../../src/modules/care-access/relationships.js';
import {
  api,
  createClinicWithAdmin,
  createPatient,
  createPlatformAdmin,
  createVerifiedDoctor,
  expectOk,
  linkCare,
  profileInput,
  randomId,
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

const readPatient = (who, patientId) => api(h, who).get(`/patients/${patientId}`);

describe('care relationships (My Doctors)', () => {
  it('patient request → doctor accept → ACTIVE, and only then the doctor can read the profile', async () => {
    const patient = await createPatient(h, 'care-p');
    const doctor = await createVerifiedDoctor(h, admin, 'care-d');

    const rel = expectOk(
      await api(h, patient).post('/care-relationships', {
        patientId: patient.patient.id,
        doctorId: doctor.doctor.id,
      }),
      201,
    );
    expect(rel).toMatchObject({ status: 'pending', initiatedBy: 'patient' });
    expect((await readPatient(doctor, patient.patient.id)).status).toBe(404); // pending ≠ access

    // The doctor sees the pending request with only the name the patient shared.
    const pending = expectOk(await api(h, doctor).get('/doctors/me/patients'));
    expect(pending[0].patient).toEqual({ displayName: patient.patient.fullName });

    // The patient cannot accept their own request.
    expect((await api(h, patient).post(`/care-relationships/${rel.id}/accept`)).body.code).toBe(
      'wrong_party',
    );
    expect(expectOk(await api(h, doctor).post(`/care-relationships/${rel.id}/accept`)).status).toBe(
      'active',
    );

    const read = expectOk(await readPatient(doctor, patient.patient.id));
    expect(read.access.relationship).toBe('treating_doctor');
    const [event] = await auditFor(h.knex, {
      actor_user_id: doctor.id,
      patient_id: patient.patient.id,
      action: 'patients:read',
      outcome: 'success',
    });
    expect(event).toMatchObject({ category: 'data_access', reason: 'treating_doctor' });
    expect(event.metadata.consentBasis).toBe('active_care_relationship');

    const team = expectOk(await api(h, patient).get('/care-relationships'));
    expect(team[0]).toMatchObject({ status: 'active', doctor: { id: doctor.doctor.id } });
    const mine = expectOk(await api(h, doctor).get('/doctors/me/patients?status=active'));
    expect(mine[0].patient).toMatchObject({
      id: patient.patient.id,
      fullName: patient.patient.fullName,
    });
  });

  it('pausing suspends access immediately; resuming restores it; ending revokes it', async () => {
    const patient = await createPatient(h, 'pause-p');
    const doctor = await createVerifiedDoctor(h, admin, 'pause-d');
    const rel = await linkCare(h, patient, doctor);
    expect((await readPatient(doctor, patient.patient.id)).status).toBe(200);

    expect((await api(h, doctor).post(`/care-relationships/${rel.id}/pause`)).body.code).toBe(
      'wrong_party',
    );
    expectOk(await api(h, patient).post(`/care-relationships/${rel.id}/pause`));
    expect((await readPatient(doctor, patient.patient.id)).status).toBe(404);
    expectOk(await api(h, patient).post(`/care-relationships/${rel.id}/resume`));
    expect((await readPatient(doctor, patient.patient.id)).status).toBe(200);

    const ended = expectOk(await api(h, doctor).post(`/care-relationships/${rel.id}/end`));
    expect(ended).toMatchObject({ status: 'ended', endReason: 'doctor_ended' });
    expect((await readPatient(doctor, patient.patient.id)).status).toBe(404);
    expect((await api(h, patient).post(`/care-relationships/${rel.id}/resume`)).status).toBe(409);
  });

  it('doctor invitations are enumeration-safe and become ACTIVE only when the patient accepts', async () => {
    const patient = await createPatient(h, 'invited-p');
    const doctor = await createVerifiedDoctor(h, admin, 'inviting-d');
    const real = await api(h, doctor).post('/care-relationships/invitations', {
      email: patient.email,
    });
    const fake = await api(h, doctor).post('/care-relationships/invitations', {
      email: 'nobody@test.healthbridge.local',
    });
    expect(real.status).toBe(202);
    expect(fake.status).toBe(202);
    expect(real.body).toEqual(fake.body);

    const [invitation] = expectOk(await api(h, patient).get('/care-relationships'));
    expect(invitation).toMatchObject({ status: 'invited', initiatedBy: 'doctor' });
    expect((await readPatient(doctor, patient.patient.id)).status).toBe(404);
    expect(
      (await api(h, doctor).post(`/care-relationships/${invitation.id}/accept`)).body.code,
    ).toBe('wrong_party');
    expectOk(await api(h, patient).post(`/care-relationships/${invitation.id}/accept`));
    expect((await readPatient(doctor, patient.patient.id)).status).toBe(200);
  });

  it('unverified applicants cannot invite patients, and cannot be requested', async () => {
    const applicant = await createUser(h, { label: 'applicant-d' });
    const draft = expectOk(
      await api(h, applicant).post('/doctors/me', {
        professionalName: 'Dr. Draft',
        registrationNumber: `DRAFT-${randomId().slice(0, 8)}`,
        registrationCouncil: 'Test Council',
        registrationYear: 2020,
        primarySpecialization: 'General',
        qualifications: [{ degree: 'MBBS', institution: 'Test', year: 2019 }],
        yearsOfExperience: 1,
      }),
      201,
    );
    const patient = await createPatient(h, 'req-unverified');
    const invite = await api(h, applicant).post('/care-relationships/invitations', {
      email: patient.email,
    });
    expect(invite.status).toBe(403); // passes gate 1 as a patient; the service requires a verified doctor
    expect(invite.body.code).toBe('doctor_not_verified');
    const req = await api(h, patient).post('/care-relationships', {
      patientId: patient.patient.id,
      doctorId: draft.id,
    });
    expect(req.status).toBe(404);
  });

  it('a guardian manages care relationships for their dependent', async () => {
    const guardian = await createPatient(h, 'care-guardian');
    const doctor = await createVerifiedDoctor(h, admin, 'paediatrician');
    const child = expectOk(
      await api(h, guardian).post('/patients/me/dependents', {
        ...profileInput('Little One'),
        relationshipType: 'parent',
      }),
      201,
    );
    await linkCare(h, guardian, doctor, { patientId: child.id });
    const team = expectOk(await api(h, guardian).get(`/care-relationships?patientId=${child.id}`));
    expect(team[0].status).toBe('active');
    expect(expectOk(await readPatient(doctor, child.id)).access.relationship).toBe(
      'treating_doctor',
    );
  });
});

describe('adversarial authorization (fail closed)', () => {
  let patientA;
  let patientB;
  let doctorA;
  let doctorB;
  let clinicA;
  let clinicB;

  beforeAll(async () => {
    patientA = await createPatient(h, 'adv-a');
    patientB = await createPatient(h, 'adv-b');
    doctorA = await createVerifiedDoctor(h, admin, 'adv-doc-a');
    doctorB = await createVerifiedDoctor(h, admin, 'adv-doc-b');
    clinicA = await createClinicWithAdmin(h, admin, 'adv-clinic-a');
    clinicB = await createClinicWithAdmin(h, admin, 'adv-clinic-b');
    // doctorA practises at clinic A and treats patient A there.
    const invite = expectOk(
      await api(h, clinicA.clinicAdmin).post(`/clinics/${clinicA.clinic.id}/doctors`, {
        doctorId: doctorA.doctor.id,
      }),
      201,
    );
    expectOk(await api(h, doctorA).post(`/clinic-memberships/${invite.id}/accept`));
    await linkCare(h, patientA, doctorA, { clinicId: clinicA.clinic.id });
  });

  it('IDOR: patient A cannot read or modify patient B; guessed IDs are indistinguishable', async () => {
    const real = await readPatient(patientA, patientB.patient.id);
    const guessed = await readPatient(patientA, randomId());
    const garbage = await readPatient(patientA, 'not-a-uuid');
    for (const res of [real, guessed, garbage]) expect(res.status).toBe(404);
    expect(real.body.detail).toBe(guessed.body.detail);
    expect(
      (await api(h, patientA).patch(`/patients/${patientB.patient.id}`, { city: 'X' })).status,
    ).toBe(404);
    expect(
      (await api(h, patientA).get(`/care-relationships?patientId=${patientB.patient.id}`)).status,
    ).toBe(404);
    expect(
      (
        await api(h, patientA).post('/care-relationships', {
          patientId: patientB.patient.id,
          doctorId: doctorA.doctor.id,
        })
      ).status,
    ).toBe(404);
  });

  it('an unrelated doctor cannot access a patient (and the denial is audited)', async () => {
    const res = await readPatient(doctorB, patientA.patient.id);
    expect(res.status).toBe(404);
    const [event] = await auditFor(h.knex, {
      actor_user_id: doctorB.id,
      patient_id: patientA.patient.id,
      outcome: 'denied',
    });
    expect(event).toMatchObject({ category: 'data_access', reason: 'relationship:not_related' });
  });

  it("a doctor cannot act on another doctor's care relationships", async () => {
    const [rel] = expectOk(await api(h, patientA).get('/care-relationships'));
    expect((await api(h, doctorB).post(`/care-relationships/${rel.id}/end`)).status).toBe(404);
  });

  /** Application-layer policy on the owner connection: RLS bypassed, app logic alone. */
  const appLayerOnly = () => {
    const careAccess = createCareAccess({ knex: h.ownerKnex });
    return createAccessPolicy({
      audit: h.container.audit,
      relationshipResolvers: careAccess.resolvers,
      consentResolver: careAccess.consentResolver,
    });
  };
  const principalOf = (user, permissions, clinicRoles = []) => ({
    userId: user.id,
    sessionId: null,
    roles: [],
    clinicRoles,
    permissions: new Set(permissions),
    clinicPermissions: new Map(),
  });
  const patientRes = (p) => ({ type: 'patient', id: p.patient.id, patientId: p.patient.id });

  it('a clinic member has no access: RLS hides the patient, and the app layer alone denies at consent', async () => {
    // Through the API (both layers): not related → 404.
    expect((await readPatient(clinicA.clinicAdmin, patientA.patient.id)).status).toBe(404);

    const principal = principalOf(
      clinicA.clinicAdmin,
      ['patients:read'],
      [{ clinicId: clinicA.clinic.id, role: 'CLINIC_ADMIN' }],
    );
    // Production path (actor transaction, RLS active): relationship invisible → gate 2.
    const withRls = await withActor(h.knex, clinicA.clinicAdmin.id, (trx) =>
      h.container.accessPolicy.evaluate({
        principal,
        permission: 'patients:read',
        resource: patientRes(patientA),
        trx,
      }),
    );
    expect(withRls).toMatchObject({ allowed: false, gate: 'relationship' });
    // Application layer alone (RLS bypassed): recognised as clinic member, but no consent basis.
    const appOnly = await appLayerOnly().evaluate({
      principal,
      permission: 'patients:read',
      resource: patientRes(patientA),
    });
    expect(appOnly).toMatchObject({
      allowed: false,
      gate: 'consent',
      relationship: 'clinic_member',
    });
  });

  it('application layer alone denies unrelated doctors and patients (independent of RLS)', async () => {
    const policy = appLayerOnly();
    for (const who of [doctorB, patientB]) {
      const decision = await policy.evaluate({
        principal: principalOf(who, ['patients:read']),
        permission: 'patients:read',
        resource: patientRes(patientA),
      });
      expect(decision).toMatchObject({ allowed: false, gate: 'relationship' });
    }
    const treating = await policy.evaluate({
      principal: principalOf(doctorA, ['patients:read']),
      permission: 'patients:read',
      resource: patientRes(patientA),
    });
    expect(treating).toMatchObject({
      allowed: true,
      relationship: 'treating_doctor',
      consentBasis: 'active_care_relationship',
    });
  });

  it('a clinic admin of another clinic cannot touch this clinic or its patients', async () => {
    expect(
      (await api(h, clinicB.clinicAdmin).get(`/clinics/${clinicA.clinic.id}/members`)).status,
    ).toBe(403);
    expect((await readPatient(clinicB.clinicAdmin, patientA.patient.id)).status).toBe(404);
  });

  it('administrative access never implies clinical access (platform admin, support)', async () => {
    const support = await createUser(h, { label: 'adv-support', roles: ['SUPPORT'] });
    for (const who of [admin, support]) {
      const res = await readPatient(who, patientA.patient.id);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('forbidden');
      expect(
        (await api(h, who).get(`/care-relationships?patientId=${patientA.patient.id}`)).status,
      ).toBe(403);
    }
  });

  it('missing consent: a treating doctor still cannot read clinical records before M5 consent', async () => {
    const principal = principalOf(doctorA, ['medical_records:read']);
    const decision = await withActor(h.knex, doctorA.id, (trx) =>
      h.container.accessPolicy.evaluate({
        principal,
        permission: 'medical_records:read',
        resource: patientRes(patientA),
        trx,
      }),
    );
    expect(decision).toMatchObject({
      allowed: false,
      gate: 'consent',
      relationship: 'treating_doctor',
    });
  });

  it('a suspended doctor loses treating access immediately', async () => {
    const patient = await createPatient(h, 'adv-susp-p');
    const doctor = await createVerifiedDoctor(h, admin, 'adv-susp-d');
    await linkCare(h, patient, doctor);
    expect((await readPatient(doctor, patient.patient.id)).status).toBe(200);
    expectOk(
      await api(h, admin).post(`/admin/doctors/${doctor.doctor.id}/suspend`, {
        reasonCode: 'registration_lapsed',
      }),
    );
    // DOCTOR role removed and the treating relationship no longer qualifies (verified only).
    expect((await readPatient(doctor, patient.patient.id)).status).toBe(404);
    expect(expectOk(await api(h, doctor).get('/auth/me')).roles).not.toContain('DOCTOR');
  });

  it('a disabled user is rejected outright', async () => {
    const patient = await createPatient(h, 'adv-disabled');
    expectOk(
      await api(h, admin).patch(`/admin/users/${patient.id}/status`, {
        status: 'disabled',
        reasonCode: 'security_concern',
      }),
    );
    expect((await api(h, patient).get('/patients/me')).status).toBe(401);
    expect((await login(h.app, { email: patient.email })).status).toBe(403);
  });

  it('a guardian cannot reach a dependent they do not guard', async () => {
    const guardian1 = await createPatient(h, 'adv-g1');
    const guardian2 = await createPatient(h, 'adv-g2');
    const child = expectOk(
      await api(h, guardian1).post('/patients/me/dependents', {
        ...profileInput('Guarded Child'),
        relationshipType: 'parent',
      }),
      201,
    );
    expect((await readPatient(guardian2, child.id)).status).toBe(404);
    expect((await api(h, guardian2).get(`/patients/${child.id}/guardians`)).status).toBe(404);
  });

  it('wrong role / missing permission is rejected at gate 1', async () => {
    expect((await api(h, patientA).get('/admin/doctor-verifications')).status).toBe(403);
    expect((await api(h, patientA).post('/admin/clinics', { name: 'Rogue Clinic' })).status).toBe(
      403,
    );
    const support = await createUser(h, { label: 'adv-support2', roles: ['SUPPORT'] });
    expect(
      (
        await api(h, support).post('/patients/me/dependents', {
          ...profileInput(),
          relationshipType: 'parent',
        })
      ).status,
    ).toBe(403);
    expect((await api(h, support).post('/patients/me', profileInput())).status).toBe(403);
    expect((await api(h).get(`/patients/${patientA.patient.id}`)).status).toBe(401);
  });
});
