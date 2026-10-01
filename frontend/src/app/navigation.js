import { PERMISSIONS as P, ROLES } from '@healthbridge/shared';

/**
 * Role-aware navigation. Each section declares the permission it needs; the server
 * enforces the same permissions on every API call, so this only shapes the UI.
 * `milestone` marks sections whose features are delivered later.
 *
 * @typedef {{ key: string, label: string, path: string, permission?: string, milestone?: string, description?: string }} NavItem
 */

/** @type {Record<string, NavItem>} */
export const SECTIONS = {
  home: { key: 'home', label: 'Home', path: '' },
  dashboard: { key: 'dashboard', label: 'Dashboard', path: '' },
  appointments: {
    key: 'appointments',
    label: 'Appointments',
    path: 'appointments',
    permission: P.APPOINTMENTS_READ,
    milestone: 'M3',
    description: 'Book and manage online and in-clinic consultations.',
  },
  records: {
    key: 'records',
    label: 'Health Records',
    path: 'records',
    permission: P.MEDICAL_RECORDS_READ,
    milestone: 'M5',
    description: 'Your reports, prescriptions and consultation history in one timeline.',
  },
  doctors: {
    key: 'doctors',
    label: 'Doctors',
    path: 'doctors',
    permission: P.APPOINTMENTS_CREATE,
    milestone: 'M2',
    description: 'The doctors you trust, and how to reach them.',
  },
  patients: {
    key: 'patients',
    label: 'Patients',
    path: 'patients',
    permission: P.MEDICAL_RECORDS_READ,
    milestone: 'M2',
    description: 'Patients who have chosen you as their doctor.',
  },
  medicalRecords: {
    key: 'medicalRecords',
    label: 'Medical Records',
    path: 'medical-records',
    permission: P.MEDICAL_RECORDS_READ,
    milestone: 'M5',
    description: 'Consented patient records with source documents.',
  },
  consultations: {
    key: 'consultations',
    label: 'Consultations',
    path: 'consultations',
    permission: P.PRESCRIPTIONS_SIGN,
    milestone: 'M9',
    description: 'Online consultations, clinical notes and outcomes.',
  },
  prescriptions: {
    key: 'prescriptions',
    label: 'Prescriptions',
    path: 'prescriptions',
    permission: P.PRESCRIPTIONS_SIGN,
    milestone: 'M9',
    description: 'Create and sign prescriptions for your consultations.',
  },
  followUps: {
    key: 'followUps',
    label: 'Follow-ups',
    path: 'follow-ups',
    permission: P.PRESCRIPTIONS_SIGN,
    milestone: 'M10',
    description: 'Scheduled follow-ups and patient responses.',
  },
  clinic: {
    key: 'clinic',
    label: 'Clinic',
    path: 'clinic',
    permission: P.CLINIC_MANAGE,
    milestone: 'M2',
    description: 'Doctors, schedules, staff and billing for your clinic.',
  },
  users: {
    key: 'users',
    label: 'Users',
    path: 'admin/users',
    permission: P.USERS_READ,
    milestone: 'M11',
    description: 'Account lookup and administration.',
  },
  verification: {
    key: 'verification',
    label: 'Doctor Verification',
    path: 'admin/verification',
    permission: P.ADMIN_DOCTORS,
    milestone: 'M2',
    description: 'Review doctor credentials before they can practise on HealthBridge.',
  },
  audit: {
    key: 'audit',
    label: 'Audit Log',
    path: 'admin/audit',
    permission: P.AUDIT_READ,
    milestone: 'M11',
    description: 'Security and access audit trail.',
  },
  profile: { key: 'profile', label: 'Profile', path: 'account', permission: P.ACCOUNT_READ },
};

const S = SECTIONS;

/** Navigation per role, in display order (as specified in the architecture). */
export const ROLE_NAVIGATION = {
  [ROLES.PATIENT]: [S.home, S.appointments, S.records, S.doctors, S.profile],
  [ROLES.DOCTOR]: [
    S.dashboard,
    S.appointments,
    S.patients,
    S.medicalRecords,
    S.consultations,
    S.prescriptions,
    S.followUps,
    S.profile,
  ],
  [ROLES.CLINIC_ADMIN]: [S.dashboard, S.clinic, S.appointments, S.profile],
  [ROLES.PLATFORM_ADMIN]: [S.dashboard, S.verification, S.users, S.audit, S.profile],
  [ROLES.SUPPORT]: [S.dashboard, S.users, S.appointments, S.profile],
};

/** When a user holds several roles, the most operational role shapes the workspace. */
const ROLE_PRIORITY = [
  ROLES.PLATFORM_ADMIN,
  ROLES.CLINIC_ADMIN,
  ROLES.DOCTOR,
  ROLES.SUPPORT,
  ROLES.PATIENT,
];

export function primaryRole(roles) {
  return ROLE_PRIORITY.find((role) => roles.includes(role)) ?? ROLES.PATIENT;
}

/** Navigation for a user: their primary role's items that their permissions allow. */
export function navigationFor(user) {
  const items = ROLE_NAVIGATION[primaryRole(user.roles)] ?? [];
  return items.filter((item) => !item.permission || user.permissions.includes(item.permission));
}

/** Every section reachable under /app (used to build routes). */
export const ALL_SECTIONS = Object.values(SECTIONS).filter((s) => s.path && s.milestone);
