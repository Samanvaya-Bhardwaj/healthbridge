import { ACCOUNT_LEVEL_PERMISSIONS } from '@healthbridge/shared';

/**
 * @typedef {object} Principal
 * @property {string} userId
 * @property {string} sessionId
 * @property {string} email
 * @property {string} fullName
 * @property {string[]} roles                       global roles
 * @property {{ clinicId: string, role: string }[]} clinicRoles  clinic-scoped roles
 * @property {Set<string>} permissions              global permissions
 * @property {Map<string, Set<string>>} clinicPermissions  per-clinic permissions
 */

const ACCOUNT_LEVEL = new Set(ACCOUNT_LEVEL_PERMISSIONS);

/**
 * Builds a principal from effective role/permission grants. Clinic-scoped grants stay
 * scoped to their clinic, except account-level permissions (own account and sessions),
 * which apply globally whichever role grants them.
 */
export function buildPrincipal({
  userId,
  sessionId,
  email,
  fullName,
  roleGrants,
  permissionGrants,
}) {
  const roles = new Set();
  const clinicRoles = [];
  for (const { role, clinicId } of roleGrants) {
    if (clinicId) clinicRoles.push({ clinicId, role });
    else roles.add(role);
  }
  const permissions = new Set();
  const clinicPermissions = new Map();
  for (const { permission, clinicId } of permissionGrants) {
    if (!clinicId || ACCOUNT_LEVEL.has(permission)) {
      permissions.add(permission);
    } else {
      if (!clinicPermissions.has(clinicId)) clinicPermissions.set(clinicId, new Set());
      clinicPermissions.get(clinicId).add(permission);
    }
  }
  return {
    userId,
    sessionId,
    email,
    fullName,
    roles: [...roles].sort(),
    clinicRoles: clinicRoles.sort(
      (a, b) => a.clinicId.localeCompare(b.clinicId) || a.role.localeCompare(b.role),
    ),
    permissions,
    clinicPermissions,
  };
}

/** Gate 1 check, clinic-aware: a global grant, or a grant for the resource's clinic. */
export function hasPermission(principal, permission, clinicId) {
  if (!principal) return false;
  if (principal.permissions?.has(permission)) return true;
  return Boolean(clinicId && principal.clinicPermissions?.get(clinicId)?.has(permission));
}

/** All role codes held, global or clinic-scoped (for display and session lifetimes). */
export const allRoleCodes = (principal) => [
  ...new Set([...principal.roles, ...principal.clinicRoles.map((g) => g.role)]),
];

/** Serializable view of a principal for API responses (never includes secrets). */
export function principalView(principal) {
  return {
    id: principal.userId,
    email: principal.email,
    fullName: principal.fullName,
    roles: allRoleCodes(principal).sort(),
    permissions: [...principal.permissions].sort(),
    clinicRoles: principal.clinicRoles,
    clinicPermissions: Object.fromEntries(
      [...principal.clinicPermissions].map(([clinicId, perms]) => [clinicId, [...perms].sort()]),
    ),
  };
}
