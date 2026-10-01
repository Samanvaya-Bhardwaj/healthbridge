import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditFor, createHarness, createUser } from './harness.js';
import {
  api,
  createClinicWithAdmin,
  createPlatformAdmin,
  createVerifiedDoctor,
  expectOk,
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

const doctorInput = (overrides = {}) => ({
  professionalName: 'Dr. Applicant',
  registrationNumber: `REG-${Math.random().toString(36).slice(2, 10)}`,
  registrationCouncil: 'Test Medical Council',
  registrationYear: 2018,
  primarySpecialization: 'Dermatology',
  qualifications: [{ degree: 'MBBS', institution: 'Test College', year: 2017 }],
  yearsOfExperience: 5,
  ...overrides,
});

describe('doctor profiles', () => {
  it('a profile exists separately from the account and is not verified by default', async () => {
    const user = await createUser(h, { label: 'applicant' });
    const profile = expectOk(await api(h, user).post('/doctors/me', doctorInput()), 201);
    expect(profile).toMatchObject({ verificationStatus: 'unverified', profileStatus: 'draft' });
    const me = expectOk(await api(h, user).get('/auth/me'));
    expect(me.roles).toEqual(['PATIENT']); // no DOCTOR role from a profile
    // Unverified doctors are not in the directory and have no public profile.
    expect((await api(h, user).get(`/doctors/${profile.id}`)).status).toBe(404);
    const directory = expectOk(await api(h, user).get('/doctors?limit=100'));
    expect(directory.map((d) => d.id)).not.toContain(profile.id);
  });

  it('registration numbers are unique per council (normalised to upper case)', async () => {
    const a = await createUser(h, { label: 'reg-a' });
    const b = await createUser(h, { label: 'reg-b' });
    expectOk(
      await api(h, a).post('/doctors/me', doctorInput({ registrationNumber: 'dup-123' })),
      201,
    );
    const res = await api(h, b).post('/doctors/me', doctorInput({ registrationNumber: 'DUP-123' }));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('registration_in_use');
  });
});

describe('verification workflow', () => {
  it('pending → under_review → verified grants the DOCTOR role and lists the doctor publicly', async () => {
    const doctor = await createVerifiedDoctor(h, admin, 'verified');
    expect(expectOk(await api(h, doctor).get('/auth/me')).roles).toEqual(['DOCTOR', 'PATIENT']);
    const profile = expectOk(await api(h, doctor).get('/doctors/me'));
    expect(profile).toMatchObject({ verificationStatus: 'verified', profileStatus: 'active' });
    expect(expectOk(await api(h, doctor).get(`/doctors/${profile.id}`)).verified).toBe(true);

    const history = expectOk(await api(h, doctor).get('/doctors/me/verification'));
    expect(history[0]).toMatchObject({
      status: 'verified',
      decisionReasonCode: 'credentials_confirmed',
    });
    expect(history[0]).not.toHaveProperty('decisionNotes'); // reviewer notes stay internal

    const decisions = await auditFor(h.knex, {
      action: 'admin.doctor_verification_decision',
      resource_id: doctor.caseId,
    });
    expect(decisions[0]).toMatchObject({
      actor_user_id: admin.id,
      reason: 'credentials_confirmed',
    });
    expect(decisions[0].metadata).toMatchObject({ decision: 'verified', roleGranted: true });
  });

  it('rejection keeps the doctor without clinical capabilities; notes never reach the audit log', async () => {
    const user = await createUser(h, { label: 'rejected' });
    expectOk(await api(h, user).post('/doctors/me', doctorInput()), 201);
    const kase = expectOk(await api(h, user).post('/doctors/me/verification'), 201);
    expectOk(await api(h, admin).post(`/admin/doctor-verifications/${kase.id}/start-review`));
    const decided = expectOk(
      await api(h, admin).post(`/admin/doctor-verifications/${kase.id}/decision`, {
        decision: 'rejected',
        reasonCode: 'registration_not_found',
        notes: 'Registry lookup returned no match for SECRET-NOTE-MARKER.',
      }),
    );
    expect(decided.status).toBe('rejected');
    expect(expectOk(await api(h, user).get('/auth/me')).roles).toEqual(['PATIENT']);
    const [event] = await auditFor(h.knex, {
      action: 'admin.doctor_verification_decision',
      resource_id: kase.id,
    });
    expect(JSON.stringify(event)).not.toContain('SECRET-NOTE-MARKER');
    // Resubmission after correcting details is allowed.
    expect((await api(h, user).post('/doctors/me/verification')).status).toBe(201);
  });

  it('enforces the state machine and locks registration details during review', async () => {
    const user = await createUser(h, { label: 'locked' });
    expectOk(await api(h, user).post('/doctors/me', doctorInput()), 201);
    const kase = expectOk(await api(h, user).post('/doctors/me/verification'), 201);
    expect((await api(h, user).post('/doctors/me/verification')).status).toBe(409); // already pending
    expect(
      (await api(h, user).patch('/doctors/me', { registrationNumber: 'CHANGED-1' })).body.code,
    ).toBe('registration_locked');
    expect((await api(h, user).patch('/doctors/me', { bio: 'Updated bio.' })).status).toBe(200);
    // Decide before review → invalid transition.
    const early = await api(h, admin).post(`/admin/doctor-verifications/${kase.id}/decision`, {
      decision: 'verified',
      reasonCode: 'credentials_confirmed',
    });
    expect(early.status).toBe(409);
  });

  it('nobody can review their own verification (separation of duties)', async () => {
    const adminDoctor = await createPlatformAdmin(h, 'admin-doctor');
    await h.container.repositories.roles.grant(adminDoctor.id, 'PATIENT', null);
    expectOk(await api(h, adminDoctor).post('/doctors/me', doctorInput()), 201);
    const kase = expectOk(await api(h, adminDoctor).post('/doctors/me/verification'), 201);
    const res = await api(h, adminDoctor).post(
      `/admin/doctor-verifications/${kase.id}/start-review`,
    );
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('self_review');
  });

  it('only platform admins can see or act on the verification queue', async () => {
    const patient = await createUser(h, { label: 'nosy' });
    const support = await createUser(h, { label: 'sup', roles: ['SUPPORT'] });
    for (const who of [patient, support]) {
      expect((await api(h, who).get('/admin/doctor-verifications')).status).toBe(403);
    }
    expect(
      expectOk(await api(h, admin).get('/admin/doctor-verifications')).length,
    ).toBeGreaterThanOrEqual(0);
  });

  it('suspension removes the DOCTOR role and the public profile', async () => {
    const doctor = await createVerifiedDoctor(h, admin, 'to-suspend');
    const res = expectOk(
      await api(h, admin).post(`/admin/doctors/${doctor.doctor.id}/suspend`, {
        reasonCode: 'misconduct_report',
      }),
    );
    expect(res).toMatchObject({ verificationStatus: 'suspended', profileStatus: 'suspended' });
    expect(expectOk(await api(h, doctor).get('/auth/me')).roles).toEqual(['PATIENT']);
    expect((await api(h, doctor).get(`/doctors/${doctor.doctor.id}`)).status).toBe(404);
  });

  it('the DOCTOR role cannot be granted directly, bypassing verification', async () => {
    const user = await createUser(h, { label: 'shortcut' });
    const res = await api(h, admin).put(`/admin/users/${user.id}/roles/DOCTOR`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('role_requires_workflow');
  });
});

describe('clinics and clinic-scoped roles', () => {
  it('platform admin creates a clinic and appoints a clinic-scoped administrator', async () => {
    const { clinic, clinicAdmin } = await createClinicWithAdmin(h, admin, 'scoped');
    const me = expectOk(await api(h, clinicAdmin).get('/auth/me'));
    expect(me.clinicRoles).toEqual([{ clinicId: clinic.id, role: 'CLINIC_ADMIN' }]);
    expect(me.clinicPermissions[clinic.id]).toContain('clinic:manage');
    expect(me.permissions).not.toContain('clinic:manage');
    const members = expectOk(await api(h, clinicAdmin).get(`/clinics/${clinic.id}/members`));
    expect(members.map((m) => m.memberRole)).toEqual(['CLINIC_ADMIN']);
  });

  it('clinic permissions do not cross clinics', async () => {
    const a = await createClinicWithAdmin(h, admin, 'clinic-a');
    const b = await createClinicWithAdmin(h, admin, 'clinic-b');
    const cross = await api(h, a.clinicAdmin).get(`/clinics/${b.clinic.id}/members`);
    expect(cross.status).toBe(403);
    const [event] = await auditFor(h.knex, { actor_user_id: a.clinicAdmin.id, outcome: 'denied' });
    expect(event.metadata.clinicId).toBe(b.clinic.id);
    expect((await api(h, a.clinicAdmin).get(`/clinics/${b.clinic.id}`)).status).toBe(403);
  });

  it('clinic roles cannot be granted globally (API and database)', async () => {
    const user = await createUser(h, { label: 'global-ca' });
    expect((await api(h, admin).put(`/admin/users/${user.id}/roles/CLINIC_ADMIN`)).body.code).toBe(
      'role_requires_workflow',
    );
    await expect(
      h.container.repositories.roles.grant(user.id, 'CLINIC_ADMIN', null),
    ).rejects.toThrow(/clinic-scoped role requires clinic_id/);
  });

  it('a clinic admin invites only verified doctors; the doctor accepts; doctors can be in many clinics', async () => {
    const a = await createClinicWithAdmin(h, admin, 'multi-a');
    const b = await createClinicWithAdmin(h, admin, 'multi-b');
    const doctor = await createVerifiedDoctor(h, admin, 'multi-doc');

    const applicant = await createUser(h, { label: 'unverified-doc' });
    const draft = expectOk(await api(h, applicant).post('/doctors/me', doctorInput()), 201);
    expect(
      (await api(h, a.clinicAdmin).post(`/clinics/${a.clinic.id}/doctors`, { doctorId: draft.id }))
        .status,
    ).toBe(404);

    for (const { clinic, clinicAdmin } of [a, b]) {
      const invite = expectOk(
        await api(h, clinicAdmin).post(`/clinics/${clinic.id}/doctors`, {
          doctorId: doctor.doctor.id,
        }),
        201,
      );
      expect(invite.status).toBe('invited');
      // Another user cannot accept the doctor's invitation.
      expect((await api(h, applicant).post(`/clinic-memberships/${invite.id}/accept`)).status).toBe(
        404,
      );
      expect(
        expectOk(await api(h, doctor).post(`/clinic-memberships/${invite.id}/accept`)).status,
      ).toBe('active');
    }
    const mine = expectOk(await api(h, doctor).get('/doctors/me/clinics'));
    expect(mine.map((m) => m.clinicId).sort()).toEqual([a.clinic.id, b.clinic.id].sort());
    const listed = expectOk(await api(h, doctor).get(`/doctors/${doctor.doctor.id}`));
    expect(listed.clinics).toHaveLength(2);
  });

  it('ending a clinic admin membership removes the scoped role; the last admin cannot leave', async () => {
    const { clinic, clinicAdmin } = await createClinicWithAdmin(h, admin, 'ending');
    const [membership] = expectOk(await api(h, clinicAdmin).get(`/clinics/${clinic.id}/members`));
    const selfLeave = await api(h, clinicAdmin).post(
      `/clinics/${clinic.id}/members/${membership.id}/end`,
    );
    expect(selfLeave.body.code).toBe('last_clinic_admin');

    expectOk(await api(h, admin).post(`/clinics/${clinic.id}/members/${membership.id}/end`));
    expect(expectOk(await api(h, clinicAdmin).get('/auth/me')).clinicRoles).toEqual([]);
    expect((await api(h, clinicAdmin).get(`/clinics/${clinic.id}/members`)).status).toBe(403);
  });

  it('deactivating a clinic suspends its clinic-scoped permissions', async () => {
    const { clinic, clinicAdmin } = await createClinicWithAdmin(h, admin, 'inactive');
    expectOk(
      await api(h, admin).patch(`/admin/clinics/${clinic.id}/status`, { status: 'inactive' }),
    );
    expect(expectOk(await api(h, clinicAdmin).get('/auth/me')).clinicRoles).toEqual([]);
  });
});
