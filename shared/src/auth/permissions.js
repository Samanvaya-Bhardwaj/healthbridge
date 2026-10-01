/**
 * Permission catalog and role → permission mapping (RBAC gate 1).
 *
 * The database (`permissions`, `role_permissions`) is the authority at runtime; this
 * catalog is the code-side contract. Migrations seed the same snapshot, and a test plus
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

  // Patients, dependents and care relationships (M2)
  PATIENTS_READ: 'patients:read',
  PATIENTS_WRITE: 'patients:write',
  DEPENDENTS_MANAGE: 'dependents:manage',
  CARE_RELATIONSHIPS_READ: 'care_relationships:read',
  CARE_RELATIONSHIPS_MANAGE: 'care_relationships:manage',

  // Doctors and clinics (M2)
  DOCTOR_PROFILE_MANAGE: 'doctor_profile:manage',
  DOCTORS_READ: 'doctors:read',
  CLINICS_READ: 'clinics:read',
  CLINIC_MANAGE: 'clinic:manage',

  // Care workflows (enforced on endpoints from later milestones)
  APPOINTMENTS_CREATE: 'appointments:create',
  APPOINTMENTS_READ: 'appointments:read',
  APPOINTMENTS_MANAGE: 'appointments:manage',
  AVAILABILITY_MANAGE: 'availability:manage',
  MEDICAL_RECORDS_READ: 'medical_records:read',
  MEDICAL_RECORDS_WRITE: 'medical_records:write',
  PRESCRIPTIONS_READ: 'prescriptions:read',
  PRESCRIPTIONS_SIGN: 'prescriptions:sign',

  // Administration
  USERS_READ: 'users:read',
  USERS_UPDATE: 'users:update',
  ADMIN_USERS: 'admin:users',
  ADMIN_DOCTORS: 'admin:doctors',
  ADMIN_CLINICS: 'admin:clinics',
  ADMIN_SESSIONS: 'admin:sessions',
  AUDIT_READ: 'audit:read',
});

export const PERMISSION_DESCRIPTIONS = Object.freeze({
  'account:read': 'Read own account profile',
  'account:update': 'Update own account profile and password',
  'sessions:read': 'List own active sessions',
  'sessions:revoke': 'Revoke own sessions',
  'patients:read': 'Read patient profiles within relationship and consent scope',
  'patients:write': 'Create and update patient profiles for self or managed dependents',
  'dependents:manage': 'Create and manage dependent family members',
  'care_relationships:read': 'Read own care relationships (My Doctors / My Patients)',
  'care_relationships:manage': 'Request, accept, pause and end care relationships',
  'doctor_profile:manage': 'Create and update own doctor profile and request verification',
  'doctors:read': 'Browse the directory of verified doctors',
  'clinics:read': 'Read clinic information',
  'clinic:manage': 'Manage own clinic (doctors, slots, staff)',
  'appointments:create': 'Create appointments',
  'appointments:read': 'Read appointments within relationship scope',
  'appointments:manage':
    'Cancel, reschedule, check in and complete appointments within relationship scope',
  'availability:manage': 'Manage consultation availability and time off',
  'medical_records:read': 'Read medical records within relationship and consent scope',
  'medical_records:write': 'Add medical records within relationship and consent scope',
  'prescriptions:read': 'Read prescriptions within relationship and consent scope',
  'prescriptions:sign': 'Create and sign prescriptions for own consultations',
  'users:read': 'Read user accounts (administration/support)',
  'users:update': 'Change user account status',
  'admin:users': 'Grant and revoke user roles',
  'admin:doctors': 'Review doctor credential verification',
  'admin:clinics': 'Create clinics and appoint clinic administrators',
  'admin:sessions': 'Revoke any user’s sessions',
  'audit:read': 'Read audit logs',
});

const P = PERMISSIONS;

/**
 * Own-account permissions. They are account-level: granted by any role, including a
 * clinic-scoped one, they apply globally (a clinic administrator can always manage
 * their own account).
 */
export const ACCOUNT_LEVEL_PERMISSIONS = Object.freeze([
  P.ACCOUNT_READ,
  P.ACCOUNT_UPDATE,
  P.SESSIONS_READ,
  P.SESSIONS_REVOKE,
]);
const OWN_ACCOUNT = ACCOUNT_LEVEL_PERMISSIONS;

export const ROLE_PERMISSIONS = Object.freeze({
  [ROLES.PATIENT]: Object.freeze([
    ...OWN_ACCOUNT,
    P.PATIENTS_READ,
    P.PATIENTS_WRITE,
    P.DEPENDENTS_MANAGE,
    P.CARE_RELATIONSHIPS_READ,
    P.CARE_RELATIONSHIPS_MANAGE,
    // Any patient may apply to join as a doctor; verification grants the DOCTOR role.
    P.DOCTOR_PROFILE_MANAGE,
    P.DOCTORS_READ,
    P.APPOINTMENTS_CREATE,
    P.APPOINTMENTS_READ,
    P.APPOINTMENTS_MANAGE,
    P.MEDICAL_RECORDS_READ,
    P.MEDICAL_RECORDS_WRITE,
    P.PRESCRIPTIONS_READ,
  ]),
  [ROLES.DOCTOR]: Object.freeze([
    ...OWN_ACCOUNT,
    P.PATIENTS_READ,
    P.CARE_RELATIONSHIPS_READ,
    P.CARE_RELATIONSHIPS_MANAGE,
    P.DOCTOR_PROFILE_MANAGE,
    P.DOCTORS_READ,
    P.CLINICS_READ,
    P.APPOINTMENTS_READ,
    P.APPOINTMENTS_MANAGE,
    P.AVAILABILITY_MANAGE,
    P.MEDICAL_RECORDS_READ,
    P.MEDICAL_RECORDS_WRITE,
    P.PRESCRIPTIONS_READ,
    P.PRESCRIPTIONS_SIGN,
  ]),
  // Clinic-scoped: these permissions apply only within the clinic of the grant.
  [ROLES.CLINIC_ADMIN]: Object.freeze([
    ...OWN_ACCOUNT,
    P.CLINICS_READ,
    P.CLINIC_MANAGE,
    P.DOCTORS_READ,
    P.APPOINTMENTS_CREATE,
    P.APPOINTMENTS_READ,
    P.APPOINTMENTS_MANAGE,
  ]),
  // Platform administrators manage accounts, clinics and verification; they do NOT
  // receive patient or clinical-record permissions.
  [ROLES.PLATFORM_ADMIN]: Object.freeze([
    ...OWN_ACCOUNT,
    P.USERS_READ,
    P.USERS_UPDATE,
    P.ADMIN_USERS,
    P.ADMIN_DOCTORS,
    P.ADMIN_CLINICS,
    P.ADMIN_SESSIONS,
    P.AUDIT_READ,
    P.CLINICS_READ,
    P.DOCTORS_READ,
  ]),
  // Support staff help users with accounts and appointments; no patient or clinical
  // records, no account changes.
  [ROLES.SUPPORT]: Object.freeze([
    ...OWN_ACCOUNT,
    P.USERS_READ,
    P.APPOINTMENTS_READ,
    P.DOCTORS_READ,
    P.CLINICS_READ,
  ]),
});

/** Role scope: clinic-scoped roles are always granted for a specific clinic. */
export const ROLE_SCOPES = Object.freeze({
  [ROLES.PATIENT]: 'global',
  [ROLES.DOCTOR]: 'global',
  [ROLES.CLINIC_ADMIN]: 'clinic',
  [ROLES.PLATFORM_ADMIN]: 'global',
  [ROLES.SUPPORT]: 'global',
});

/**
 * Roles that cannot be granted directly through the role-administration endpoint:
 * DOCTOR comes only from credential verification; clinic roles only from clinic
 * appointment/membership workflows.
 */
export const WORKFLOW_GRANTED_ROLES = Object.freeze([ROLES.DOCTOR, ROLES.CLINIC_ADMIN]);

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
