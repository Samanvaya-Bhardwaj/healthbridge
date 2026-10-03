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

  // Payments (M4)
  PAYMENTS_CREATE: 'payments:create',
  PAYMENTS_READ: 'payments:read',
  PAYMENTS_REFUND: 'payments:refund',
  MEDICAL_RECORDS_READ: 'medical_records:read',
  MEDICAL_RECORDS_WRITE: 'medical_records:write',
  PRESCRIPTIONS_READ: 'prescriptions:read',
  PRESCRIPTIONS_SIGN: 'prescriptions:sign',

  // Consent and access transparency (M5)
  CONSENTS_MANAGE: 'consents:manage',
  CONSENTS_READ: 'consents:read',
  ACCESS_LOG_READ: 'access_log:read',

  // Document intelligence (M6)
  LAB_RESULTS_VERIFY: 'lab_results:verify',

  // Timeline (M7)
  RECORDS_EXPORT: 'records:export',

  // AI assistance (M8)
  AI_ASSIST_USE: 'ai_assist:use',

  // Consultations (M9)
  CONSULTATIONS_CONDUCT: 'consultations:conduct',

  // Administration
  USERS_READ: 'users:read',
  USERS_UPDATE: 'users:update',
  ADMIN_USERS: 'admin:users',
  ADMIN_DOCTORS: 'admin:doctors',
  ADMIN_CLINICS: 'admin:clinics',
  ADMIN_SESSIONS: 'admin:sessions',
  AUDIT_READ: 'audit:read',
  OPERATIONS_MANAGE: 'operations:manage',
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
  'payments:create': 'Pay for own or managed dependents’ appointments',
  'payments:read': 'Read own or managed dependents’ payment and refund details',
  'payments:refund': 'Issue refunds for appointments within relationship scope',
  'medical_records:read': 'Read medical records within relationship and consent scope',
  'medical_records:write': 'Add medical records within relationship and consent scope',
  'prescriptions:read': 'Read prescriptions within relationship and consent scope',
  'prescriptions:sign': 'Create and sign prescriptions for own consultations',
  'consents:manage': 'Grant and revoke access to own or managed dependents’ records',
  'consents:read': 'List consents given (patient side) or received (doctor)',
  'access_log:read': 'See who accessed own or managed dependents’ records',
  'lab_results:verify': 'Verify AI-extracted lab values into the record',
  'records:export': 'Export own or managed dependents’ health timeline',
  'ai_assist:use': 'Use AI briefs and record questions for consented patients',
  'consultations:conduct': 'Start own consultations, write clinical notes and record outcomes',
  'users:read': 'Read user accounts (administration/support)',
  'users:update': 'Change user account status',
  'admin:users': 'Grant and revoke user roles',
  'admin:doctors': 'Review doctor credential verification',
  'admin:clinics': 'Create clinics and appoint clinic administrators',
  'admin:sessions': 'Revoke any user’s sessions',
  'audit:read': 'Read audit logs',
  'operations:manage': 'Inspect and retry failed background jobs (no patient data)',
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
    P.PAYMENTS_CREATE,
    P.PAYMENTS_READ,
    P.CONSENTS_MANAGE,
    P.CONSENTS_READ,
    P.ACCESS_LOG_READ,
    P.RECORDS_EXPORT,
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
    // Refunds for the doctor's own appointments; no access to payment details.
    P.PAYMENTS_REFUND,
    // Consents received; record access still needs an active consent per patient.
    P.CONSENTS_READ,
    // Human promotion of AI-extracted lab values (with consent).
    P.LAB_RESULTS_VERIFY,
    // AI briefs and record questions (with consent and the patient's AI opt-in).
    P.AI_ASSIST_USE,
    P.MEDICAL_RECORDS_READ,
    P.MEDICAL_RECORDS_WRITE,
    P.PRESCRIPTIONS_READ,
    P.PRESCRIPTIONS_SIGN,
    P.CONSULTATIONS_CONDUCT,
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
    P.PAYMENTS_REFUND,
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
    // Background-job operations: identifiers and failure reasons only, no financial or
    // clinical content.
    P.OPERATIONS_MANAGE,
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
