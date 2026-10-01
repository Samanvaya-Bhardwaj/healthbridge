/**
 * Permission catalog and role → permission mapping (RBAC gate 1).
 *
 * The database (`permissions`, `role_permissions`) is the authority at runtime; this
 * catalog is the code-side contract. A migration seeds the same snapshot, and a test plus
 * a startup check fail if the two drift apart.
 *
 * A permission only answers "may this kind of user attempt this kind of action?".
 * Access to a specific resource additionally requires the resource-relationship and
 * (for patient data) active-consent gates enforced by the backend AccessPolicy.
 */

import { ROLES } from '../roles.js';

export const PERMISSIONS = Object.freeze({
  // Own account and sessions
  ACCOUNT_READ: 'account:read',
  ACCOUNT_UPDATE: 'account:update',
  SESSIONS_READ: 'sessions:read',
  SESSIONS_REVOKE: 'sessions:revoke',

  // Care workflows (enforced on endpoints from later milestones)
  APPOINTMENTS_CREATE: 'appointments:create',
  APPOINTMENTS_READ: 'appointments:read',
  MEDICAL_RECORDS_READ: 'medical_records:read',
  MEDICAL_RECORDS_WRITE: 'medical_records:write',
  PRESCRIPTIONS_READ: 'prescriptions:read',
  PRESCRIPTIONS_SIGN: 'prescriptions:sign',
  CLINIC_MANAGE: 'clinic:manage',

  // Administration
  USERS_READ: 'users:read',
  USERS_UPDATE: 'users:update',
  ADMIN_USERS: 'admin:users',
  ADMIN_DOCTORS: 'admin:doctors',
  ADMIN_SESSIONS: 'admin:sessions',
  AUDIT_READ: 'audit:read',
});

export const PERMISSION_DESCRIPTIONS = Object.freeze({
  'account:read': 'Read own account profile',
  'account:update': 'Update own account profile and password',
  'sessions:read': 'List own active sessions',
  'sessions:revoke': 'Revoke own sessions',
  'appointments:create': 'Create appointments',
  'appointments:read': 'Read appointments within relationship scope',
  'medical_records:read': 'Read medical records within relationship and consent scope',
  'medical_records:write': 'Add medical records within relationship and consent scope',
  'prescriptions:read': 'Read prescriptions within relationship and consent scope',
  'prescriptions:sign': 'Create and sign prescriptions for own consultations',
  'clinic:manage': 'Manage own clinic (doctors, slots, staff)',
  'users:read': 'Read user accounts (administration/support)',
  'users:update': 'Change user account status',
  'admin:users': 'Grant and revoke user roles',
  'admin:doctors': 'Review doctor credential verification',
  'admin:sessions': 'Revoke any user’s sessions',
  'audit:read': 'Read audit logs',
});

const P = PERMISSIONS;
const OWN_ACCOUNT = [P.ACCOUNT_READ, P.ACCOUNT_UPDATE, P.SESSIONS_READ, P.SESSIONS_REVOKE];

export const ROLE_PERMISSIONS = Object.freeze({
  [ROLES.PATIENT]: Object.freeze([
    ...OWN_ACCOUNT,
    P.APPOINTMENTS_CREATE,
    P.APPOINTMENTS_READ,
    P.MEDICAL_RECORDS_READ,
    P.MEDICAL_RECORDS_WRITE,
    P.PRESCRIPTIONS_READ,
  ]),
  [ROLES.DOCTOR]: Object.freeze([
    ...OWN_ACCOUNT,
    P.APPOINTMENTS_READ,
    P.MEDICAL_RECORDS_READ,
    P.MEDICAL_RECORDS_WRITE,
    P.PRESCRIPTIONS_READ,
    P.PRESCRIPTIONS_SIGN,
  ]),
  [ROLES.CLINIC_ADMIN]: Object.freeze([
    ...OWN_ACCOUNT,
    P.APPOINTMENTS_CREATE,
    P.APPOINTMENTS_READ,
    P.CLINIC_MANAGE,
  ]),
  // Platform administrators manage accounts and verification; they do NOT receive
  // clinical-record permissions.
  [ROLES.PLATFORM_ADMIN]: Object.freeze([
    ...OWN_ACCOUNT,
    P.USERS_READ,
    P.USERS_UPDATE,
    P.ADMIN_USERS,
    P.ADMIN_DOCTORS,
    P.ADMIN_SESSIONS,
    P.AUDIT_READ,
  ]),
  // Support staff can look up accounts and appointments to help users; no medical
  // records, no account changes.
  [ROLES.SUPPORT]: Object.freeze([...OWN_ACCOUNT, P.USERS_READ, P.APPOINTMENTS_READ]),
});

/** Roles whose sessions use stricter (shorter) lifetimes. */
export const PRIVILEGED_ROLES = Object.freeze([
  ROLES.DOCTOR,
  ROLES.CLINIC_ADMIN,
  ROLES.PLATFORM_ADMIN,
  ROLES.SUPPORT,
]);

export const ALL_PERMISSIONS = Object.freeze(Object.values(PERMISSIONS));
export const ALL_ROLES = Object.freeze(Object.values(ROLES));

/** Union of permissions granted by a set of roles. */
export function permissionsForRoles(roles) {
  const result = new Set();
  for (const role of roles) {
    for (const permission of ROLE_PERMISSIONS[role] ?? []) result.add(permission);
  }
  return result;
}
