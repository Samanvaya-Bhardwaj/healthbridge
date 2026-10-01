import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, PERMISSIONS, ROLE_PERMISSIONS, ROLES } from '@healthbridge/shared';
import { diffPermissionCatalog } from '../../../src/core/authz/catalogCheck.js';

const CLINICAL = [
  PERMISSIONS.MEDICAL_RECORDS_READ,
  PERMISSIONS.MEDICAL_RECORDS_WRITE,
  PERMISSIONS.PRESCRIPTIONS_READ,
  PERMISSIONS.PRESCRIPTIONS_SIGN,
];

describe('RBAC catalog invariants', () => {
  it('every role maps only to known permissions', () => {
    for (const perms of Object.values(ROLE_PERMISSIONS)) {
      for (const p of perms) expect(ALL_PERMISSIONS).toContain(p);
    }
  });

  it('every role can manage its own account and sessions', () => {
    for (const perms of Object.values(ROLE_PERMISSIONS)) {
      expect(perms).toEqual(
        expect.arrayContaining([
          'account:read',
          'account:update',
          'sessions:read',
          'sessions:revoke',
        ]),
      );
    }
  });

  it('administrative and support roles have no clinical-record permissions', () => {
    for (const role of [ROLES.PLATFORM_ADMIN, ROLES.SUPPORT, ROLES.CLINIC_ADMIN]) {
      for (const p of CLINICAL) expect(ROLE_PERMISSIONS[role]).not.toContain(p);
    }
  });

  it('only doctors can sign prescriptions; only platform admins can read audit logs', () => {
    const holders = (p) =>
      Object.entries(ROLE_PERMISSIONS)
        .filter(([, perms]) => perms.includes(p))
        .map(([r]) => r);
    expect(holders(PERMISSIONS.PRESCRIPTIONS_SIGN)).toEqual([ROLES.DOCTOR]);
    expect(holders(PERMISSIONS.AUDIT_READ)).toEqual([ROLES.PLATFORM_ADMIN]);
    expect(holders(PERMISSIONS.ADMIN_USERS)).toEqual([ROLES.PLATFORM_ADMIN]);
  });

  it('detects drift between database and code', () => {
    const mapping = Object.entries(ROLE_PERMISSIONS).flatMap(([role, perms]) =>
      perms.map((permission) => ({ role, permission })),
    );
    expect(diffPermissionCatalog({ permissions: [...ALL_PERMISSIONS], mapping })).toEqual({
      missingPermissions: [],
      unexpectedPermissions: [],
      mappingDiff: [],
      scopeDiff: [],
    });
    const drifted = diffPermissionCatalog({
      permissions: [...ALL_PERMISSIONS.filter((p) => p !== 'audit:read'), 'rogue:perm'],
      mapping: [...mapping, { role: 'SUPPORT', permission: 'audit:read' }],
    });
    expect(drifted.missingPermissions).toEqual(['audit:read']);
    expect(drifted.unexpectedPermissions).toEqual(['rogue:perm']);
    expect(drifted.mappingDiff).toEqual(['unexpected SUPPORT:audit:read']);
  });
});
