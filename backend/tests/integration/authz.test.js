import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { assertPermissionCatalog } from '../../src/core/authz/catalogCheck.js';
import { authHeader, auditFor, createHarness, createUser } from './harness.js';

let h;
let patient;
let doctor;
let clinicAdmin;
let admin;
let support;

beforeAll(async () => {
  h = await createHarness();
  [patient, doctor, clinicAdmin, admin, support] = await Promise.all([
    createUser(h, { label: 'patient' }),
    createUser(h, { label: 'doctor', roles: ['DOCTOR'] }),
    createUser(h, { label: 'clinicadmin', roles: ['CLINIC_ADMIN'] }),
    createUser(h, { label: 'admin', roles: ['PLATFORM_ADMIN'] }),
    createUser(h, { label: 'support', roles: ['SUPPORT'] }),
  ]);
});
afterAll(async () => {
  await h.close();
});

const get = (path, who) =>
  request(h.app)
    .get(path)
    .set(who ? authHeader(who.session) : {});

describe('database RBAC catalog', () => {
  it('matches the code contract in @healthbridge/shared', async () => {
    await expect(assertPermissionCatalog(h.container.repositories.roles)).resolves.toBeUndefined();
  });
});

describe('role → permission enforcement', () => {
  it('unauthenticated requests are rejected on every protected endpoint', async () => {
    for (const path of [
      '/api/v1/auth/me',
      '/api/v1/auth/sessions',
      '/api/v1/users/me',
      '/api/v1/admin/users',
      '/api/v1/admin/audit-logs',
    ]) {
      const res = await get(path);
      expect(res.status, path).toBe(401);
      expect(res.body.code).toBe('unauthenticated');
    }
  });

  it('a forged or garbage bearer token is rejected', async () => {
    const res = await request(h.app).get('/api/v1/auth/me').set('Authorization', 'Bearer a.b.c');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('token_invalid');
  });

  it('patient: own account yes, administration no', async () => {
    expect((await get('/api/v1/users/me', patient)).status).toBe(200);
    expect((await get('/api/v1/admin/users', patient)).status).toBe(403);
    expect((await get('/api/v1/admin/audit-logs', patient)).status).toBe(403);
  });

  it('doctor: clinical permissions but no administration', async () => {
    const me = await get('/api/v1/auth/me', doctor);
    expect(me.body.data.permissions).toEqual(
      expect.arrayContaining(['prescriptions:sign', 'medical_records:read']),
    );
    expect((await get('/api/v1/admin/users', doctor)).status).toBe(403);
  });

  it('clinic admin: clinic management, no platform administration or clinical records', async () => {
    const me = await get('/api/v1/auth/me', clinicAdmin);
    // clinic:manage is clinic-scoped (M2): held for their clinic only, never globally.
    const [{ clinicId }] = me.body.data.clinicRoles;
    expect(me.body.data.clinicPermissions[clinicId]).toContain('clinic:manage');
    expect(me.body.data.permissions).not.toContain('clinic:manage');
    expect(me.body.data.permissions).not.toContain('medical_records:read');
    expect((await get('/api/v1/admin/users', clinicAdmin)).status).toBe(403);
  });

  it('platform admin: administration and audit, but no clinical-record permissions', async () => {
    expect((await get('/api/v1/admin/users?limit=5', admin)).status).toBe(200);
    expect((await get('/api/v1/admin/audit-logs?limit=5', admin)).status).toBe(200);
    const me = await get('/api/v1/auth/me', admin);
    expect(me.body.data.permissions).not.toContain('medical_records:read');
  });

  it('support: can read accounts but cannot change them or read audit logs', async () => {
    expect((await get(`/api/v1/admin/users/${patient.id}`, support)).status).toBe(200);
    const update = await request(h.app)
      .patch(`/api/v1/admin/users/${patient.id}/status`)
      .set(authHeader(support.session))
      .send({ status: 'disabled', reasonCode: 'other' });
    expect(update.status).toBe(403);
    expect((await get('/api/v1/admin/audit-logs', support)).status).toBe(403);
  });

  it('denied attempts are audited with actor, permission and endpoint', async () => {
    const res = await get('/api/v1/admin/audit-logs', doctor).set(
      'X-Request-Id',
      '0192b6f0a1b2c3d4e5f60718293a4b99',
    );
    expect(res.status).toBe(403);
    const [event] = await auditFor(h.knex, { request_id: '0192b6f0a1b2c3d4e5f60718293a4b99' });
    expect(event).toMatchObject({
      category: 'authorization',
      action: 'audit:read',
      outcome: 'denied',
      actor_user_id: doctor.id,
      actor_roles: ['DOCTOR'],
      reason: 'permission:missing_permission',
    });
    expect(event.metadata.endpoint).toBe('GET /api/v1/admin/audit-logs');
  });
});

describe('resource relationship (gate 2)', () => {
  it("a user cannot revoke another user's session (404, audited)", async () => {
    const otherSessionId = doctor.session.refreshToken.split('.')[0];
    const res = await request(h.app)
      .delete(`/api/v1/auth/sessions/${otherSessionId}`)
      .set(authHeader(patient.session));
    expect(res.status).toBe(404);
    expect((await get('/api/v1/auth/me', doctor)).status).toBe(200); // untouched
    const [event] = await auditFor(h.knex, {
      actor_user_id: patient.id,
      resource_id: otherSessionId,
    });
    expect(event).toMatchObject({ outcome: 'denied', reason: 'relationship:not_related' });
  });
});

describe('administration takes effect immediately', () => {
  it('granting and revoking a role changes permissions on the next request', async () => {
    const user = await createUser(h, { label: 'promote' });
    const grant = await request(h.app)
      .put(`/api/v1/admin/users/${user.id}/roles/SUPPORT`)
      .set(authHeader(admin.session));
    expect(grant.status).toBe(200);
    expect(grant.body.data.roles).toEqual(['PATIENT', 'SUPPORT']); // patient promoted to support
    expect((await get('/api/v1/admin/users', user)).status).toBe(200);

    await request(h.app)
      .delete(`/api/v1/admin/users/${user.id}/roles/SUPPORT`)
      .set(authHeader(admin.session));
    expect((await get('/api/v1/admin/users', user)).status).toBe(403);
  });

  it('disabling an account revokes its sessions immediately', async () => {
    const user = await createUser(h, { label: 'todisable' });
    const res = await request(h.app)
      .patch(`/api/v1/admin/users/${user.id}/status`)
      .set(authHeader(admin.session))
      .send({ status: 'disabled', reasonCode: 'security_concern' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('disabled');
    expect((await get('/api/v1/auth/me', user)).status).toBe(401);
  });

  it('admins cannot lock themselves out', async () => {
    const self = await request(h.app)
      .patch(`/api/v1/admin/users/${admin.id}/status`)
      .set(authHeader(admin.session))
      .send({ status: 'disabled', reasonCode: 'other' });
    expect(self.status).toBe(400);
    const demote = await request(h.app)
      .delete(`/api/v1/admin/users/${admin.id}/roles/PLATFORM_ADMIN`)
      .set(authHeader(admin.session));
    expect(demote.status).toBe(400);
  });

  it('admin can revoke all sessions of a user', async () => {
    const user = await createUser(h, { label: 'kick' });
    const res = await request(h.app)
      .post(`/api/v1/admin/users/${user.id}/sessions/revoke`)
      .set(authHeader(admin.session));
    expect(res.body.data.revoked).toBe(1);
    expect((await get('/api/v1/auth/me', user)).status).toBe(401);
  });

  it('unknown or malformed user IDs return 404, not 500', async () => {
    expect((await get('/api/v1/admin/users/not-a-uuid', admin)).status).toBe(404);
    expect(
      (await get('/api/v1/admin/users/0192b6f0-0000-7000-8000-00000000dead', admin)).status,
    ).toBe(404);
  });

  it('invalid roles are rejected by validation', async () => {
    const res = await request(h.app)
      .put(`/api/v1/admin/users/${patient.id}/roles/SUPERUSER`)
      .set(authHeader(admin.session));
    expect(res.status).toBe(400);
  });
});
