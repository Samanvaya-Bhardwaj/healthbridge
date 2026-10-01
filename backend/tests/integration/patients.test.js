import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditFor, createHarness, createUser } from './harness.js';
import { api, createPatient, expectOk, profileInput } from './m2fixtures.js';

let h;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

describe('patient profiles', () => {
  it('a user creates, reads and updates their own profile (separate from the account)', async () => {
    const user = await createUser(h, { label: 'profile' });
    expect((await api(h, user).get('/patients/me')).status).toBe(404);

    const created = expectOk(
      await api(h, user).post('/patients/me', profileInput('Asha Verma')),
      201,
    );
    expect(created).toMatchObject({
      fullName: 'Asha Verma',
      dateOfBirth: '1991-04-12',
      hasOwnAccount: true,
    });
    expect(created).not.toHaveProperty('userId');

    const updated = expectOk(
      await api(h, user).patch('/patients/me', {
        preferredName: 'Asha',
        emergencyContactName: 'Ravi Verma',
        emergencyContactPhone: '+919800002222',
      }),
    );
    expect(updated.preferredName).toBe('Asha');
    expect(expectOk(await api(h, user).get('/patients/me')).emergencyContactName).toBe(
      'Ravi Verma',
    );

    const [event] = await auditFor(h.knex, {
      action: 'patient.profile_update',
      resource_id: created.id,
    });
    expect(event).toMatchObject({ category: 'data_access', patient_id: created.id });
    expect(event.metadata.fields).toEqual([
      'preferredName',
      'emergencyContactName',
      'emergencyContactPhone',
    ]);
    expect(JSON.stringify(event)).not.toContain('Ravi Verma'); // field names only, never values
  });

  it('rejects a second profile, future birth dates, and incomplete emergency contacts', async () => {
    const user = await createPatient(h, 'dup-profile');
    expect((await api(h, user).post('/patients/me', profileInput())).status).toBe(409);
    expect((await api(h, user).patch('/patients/me', { dateOfBirth: '2999-01-01' })).status).toBe(
      400,
    );
    // Partial update validated against the merged profile.
    const res = await api(h, user).patch('/patients/me', { emergencyContactName: 'Only A Name' });
    expect(res.status).toBe(400);
    expect(res.body.errors[0].path).toBe('body.emergencyContactPhone');
  });

  it('cannot set ownership fields or unknown fields', async () => {
    const user = await createUser(h, { label: 'mass-assign' });
    const res = await api(h, user).post('/patients/me', {
      ...profileInput(),
      userId: user.id,
      status: 'archived',
    });
    expect(res.status).toBe(400);
  });
});

describe('dependents and guardianships', () => {
  it('a guardian creates a dependent and manages their profile through an explicit guardianship', async () => {
    const guardian = await createPatient(h, 'guardian');
    const dependent = expectOk(
      await api(h, guardian).post('/patients/me/dependents', {
        ...profileInput('Kamala Elder'),
        dateOfBirth: '1955-02-01',
        relationshipType: 'child',
      }),
      201,
    );
    expect(dependent).toMatchObject({
      fullName: 'Kamala Elder',
      hasOwnAccount: false,
      guardianship: { relationshipType: 'child', accessScope: 'manage' },
    });

    const read = expectOk(await api(h, guardian).get(`/patients/${dependent.id}`));
    expect(read.access.relationship).toBe('guardian_dependent');
    expect(
      expectOk(await api(h, guardian).patch(`/patients/${dependent.id}`, { city: 'Mumbai' })).city,
    ).toBe('Mumbai');

    const list = expectOk(await api(h, guardian).get('/patients/me/dependents'));
    expect(list.map((d) => d.id)).toEqual([dependent.id]);
    const guardians = expectOk(await api(h, guardian).get(`/patients/${dependent.id}/guardians`));
    expect(guardians[0]).toMatchObject({ basis: 'created_dependent', status: 'active' });
  });

  it('family membership grants nothing: an unrelated patient cannot see or edit the dependent', async () => {
    const guardian = await createPatient(h, 'g2');
    const stranger = await createPatient(h, 'stranger');
    const dependent = expectOk(
      await api(h, guardian).post('/patients/me/dependents', {
        ...profileInput('Child One'),
        relationshipType: 'parent',
      }),
      201,
    );
    expect((await api(h, stranger).get(`/patients/${dependent.id}`)).status).toBe(404);
    expect((await api(h, stranger).patch(`/patients/${dependent.id}`, { city: 'X' })).status).toBe(
      404,
    );
    expect((await api(h, stranger).get(`/patients/${dependent.id}/guardians`)).status).toBe(404);
  });

  it('a view-only guardian can read but not change the dependent', async () => {
    const owner = await createPatient(h, 'g-owner');
    const viewer = await createPatient(h, 'g-viewer');
    const dependent = expectOk(
      await api(h, owner).post('/patients/me/dependents', {
        ...profileInput('Shared Child'),
        relationshipType: 'parent',
      }),
      201,
    );
    // M2 has no UI to delegate view access yet; the model supports it (owner-level fixture).
    await h.ownerKnex('patient_guardianships').insert({
      id: (await import('node:crypto')).randomUUID(),
      patient_id: dependent.id,
      guardian_user_id: viewer.id,
      relationship_type: 'grandparent',
      access_scope: 'view',
      basis: 'legal_authority',
      status: 'active',
      started_at: new Date(),
      created_by_user_id: owner.id,
    });
    expect(
      expectOk(await api(h, viewer).get(`/patients/${dependent.id}`)).access.relationship,
    ).toBe('guardian_dependent');
    expect((await api(h, viewer).patch(`/patients/${dependent.id}`, { city: 'X' })).status).toBe(
      404,
    );
  });

  it('ending the last guardianship archives a dependent without an account and removes access', async () => {
    const guardian = await createPatient(h, 'g-end');
    const dependent = expectOk(
      await api(h, guardian).post('/patients/me/dependents', {
        ...profileInput('Leaving Child'),
        relationshipType: 'parent',
      }),
      201,
    );
    const result = expectOk(
      await api(h, guardian).post(`/guardianships/${dependent.guardianship.id}/end`),
    );
    expect(result).toMatchObject({ status: 'ended', dependentArchived: true });
    expect((await api(h, guardian).get(`/patients/${dependent.id}`)).status).toBe(404);
    const [event] = await auditFor(h.knex, {
      action: 'patient.guardianship_end',
      resource_id: dependent.guardianship.id,
    });
    expect(event.metadata).toMatchObject({ endedBy: 'guardian', dependentArchived: true });
  });

  it("a guardian cannot end someone else's guardianship", async () => {
    const guardian = await createPatient(h, 'g-a');
    const other = await createPatient(h, 'g-b');
    const dependent = expectOk(
      await api(h, guardian).post('/patients/me/dependents', {
        ...profileInput('Child Two'),
        relationshipType: 'parent',
      }),
      201,
    );
    expect(
      (await api(h, other).post(`/guardianships/${dependent.guardianship.id}/end`)).status,
    ).toBe(404);
  });
});
