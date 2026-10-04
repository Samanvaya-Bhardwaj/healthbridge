import {
  Activity,
  BadgeCheck,
  Bell,
  Building2,
  CalendarDays,
  ClipboardList,
  FileText,
  HeartPulse,
  History,
  Home,
  KeyRound,
  LayoutDashboard,
  Pill,
  ScrollText,
  ServerCog,
  ShieldCheck,
  Stethoscope,
  UserRound,
  Users,
  UsersRound,
} from 'lucide-react';
import { PERMISSIONS as P, ROLES } from '@healthbridge/shared';

/**
 * Role-aware navigation. Each section declares the permission it needs; the server
 * enforces the same permissions on every API call, so this only shapes the UI. Every
 * section with a path has a page wired in routes.jsx.
 *
 * Each role gets its own structure, order and wording (ROLE_NAVIGATION): patients see a
 * care-centred menu, doctors start from today's work, clinic admins from clinic
 * operations, platform admins from administration.
 *
 * @typedef {{ key: string, label: string, path: string, permission?: string, description?: string, icon?: import('react').ComponentType<any>, group?: string }} NavItem
 */

/** @type {Record<string, NavItem>} */
export const SECTIONS = {
  home: { key: 'home', label: 'Home', path: '', icon: Home },
  dashboard: { key: 'dashboard', label: 'Overview', path: '', icon: LayoutDashboard },
  appointments: {
    key: 'appointments',
    label: 'Appointments',
    path: 'appointments',
    permission: P.APPOINTMENTS_READ,
    icon: CalendarDays,
    description: 'Book and manage online and in-clinic consultations.',
  },
  records: {
    key: 'records',
    label: 'Health Records',
    path: 'records',
    permission: P.MEDICAL_RECORDS_READ,
    icon: FileText,
    description: 'Your reports and documents, checked for safety before they are stored.',
  },
  prescriptions: {
    key: 'prescriptions',
    label: 'Prescriptions',
    path: 'prescriptions',
    permission: P.PRESCRIPTIONS_READ,
    icon: Pill,
    description: 'Signed prescriptions from your doctors, ready to download.',
  },
  timeline: {
    key: 'timeline',
    label: 'Timeline',
    path: 'timeline',
    permission: P.MEDICAL_RECORDS_READ,
    icon: History,
    description: 'Your visits, documents and verified results in one history.',
  },
  doctors: {
    key: 'doctors',
    label: 'My Doctors',
    path: 'doctors',
    permission: P.CARE_RELATIONSHIPS_READ,
    icon: Stethoscope,
    description: 'The doctors you trust, and how to reach them.',
  },
  patients: {
    key: 'patients',
    label: 'My Patients',
    path: 'patients',
    permission: P.CARE_RELATIONSHIPS_READ,
    icon: UsersRound,
    description: 'Patients who have chosen you as their doctor, and new requests.',
  },
  medicalRecords: {
    key: 'medicalRecords',
    label: 'Patient Records',
    path: 'medical-records',
    permission: P.MEDICAL_RECORDS_READ,
    icon: FileText,
    description: 'Records your patients have chosen to share with you.',
  },
  privacy: {
    key: 'privacy',
    label: 'Privacy & Access',
    path: 'privacy',
    permission: P.CONSENTS_MANAGE,
    icon: ShieldCheck,
    description: 'Who can see your records, and who has looked at them.',
  },
  followUps: {
    key: 'followUps',
    label: 'Follow-ups',
    path: 'follow-ups',
    permission: P.APPOINTMENTS_READ,
    icon: HeartPulse,
    description: 'Check-ins after a consultation, and how patients are doing.',
  },
  notifications: {
    key: 'notifications',
    label: 'Notifications',
    path: 'notifications',
    permission: P.NOTIFICATIONS_READ,
    icon: Bell,
    description: 'Updates about bookings, payments, records and follow-ups.',
  },
  clinic: {
    key: 'clinic',
    label: 'Clinic team',
    path: 'clinic',
    permission: P.CLINIC_MANAGE,
    icon: Building2,
    description: 'Doctors and administrators at your clinic.',
  },
  users: {
    key: 'users',
    label: 'Users',
    path: 'admin/users',
    permission: P.USERS_READ,
    icon: Users,
    description: 'Account lookup and administration.',
  },
  verification: {
    key: 'verification',
    label: 'Doctor verification',
    path: 'admin/verification',
    permission: P.ADMIN_DOCTORS,
    icon: BadgeCheck,
    description: 'Review doctor credentials before they can practise on HealthBridge.',
  },
  clinics: {
    key: 'clinics',
    label: 'Clinics',
    path: 'admin/clinics',
    permission: P.ADMIN_CLINICS,
    icon: Building2,
    description: 'Create clinics and appoint their administrators.',
  },
  audit: {
    key: 'audit',
    label: 'Audit log',
    path: 'admin/audit',
    permission: P.AUDIT_READ,
    icon: ScrollText,
    description: 'Security and access audit trail.',
  },
  operations: {
    key: 'operations',
    label: 'Operations',
    path: 'admin/operations',
    permission: P.OPERATIONS_MANAGE,
    icon: ServerCog,
    description: 'Background jobs, queues and jobs that need attention.',
  },
  patientProfile: {
    key: 'patientProfile',
    label: 'Profile',
    path: 'profile',
    permission: P.PATIENTS_WRITE,
    icon: UserRound,
    description: 'Your health profile and the family members whose care you manage.',
  },
  doctorProfile: {
    key: 'doctorProfile',
    label: 'Professional profile',
    path: 'doctor-profile',
    permission: P.DOCTOR_PROFILE_MANAGE,
    icon: ClipboardList,
    description: 'Your professional profile, verification status and clinics.',
  },
  account: {
    key: 'account',
    label: 'Sign-in & security',
    path: 'account',
    permission: P.ACCOUNT_READ,
    icon: KeyRound,
    description: 'Your password, email and signed-in devices.',
  },
};

const S = SECTIONS;
/** The same section shown with role-specific wording and grouping. */
const as = (section, overrides) => ({ ...section, ...overrides });

/** Navigation per role, in display order, grouped under plain-language headings. */
export const ROLE_NAVIGATION = {
  [ROLES.PATIENT]: [
    as(S.home, { group: 'My care' }),
    as(S.doctors, { group: 'My care' }),
    as(S.appointments, { group: 'My care' }),
    as(S.followUps, {
      group: 'My care',
      description: 'Short check-ins from your doctor after a consultation.',
    }),
    as(S.records, { group: 'My health' }),
    as(S.prescriptions, { group: 'My health' }),
    as(S.timeline, { group: 'My health' }),
    as(S.notifications, {
      group: 'Account',
      description: 'Updates about your appointments, payments, records and check-ins.',
    }),
    as(S.privacy, { group: 'Account' }),
    as(S.patientProfile, { group: 'Account' }),
    as(S.account, { group: 'Account' }),
  ],
  [ROLES.DOCTOR]: [
    as(S.dashboard, { label: 'Today', icon: Activity, group: 'Clinical work' }),
    as(S.appointments, {
      label: 'Schedule',
      group: 'Clinical work',
      description: 'Your appointments, and when patients can book you.',
    }),
    as(S.followUps, { group: 'Clinical work' }),
    as(S.patients, { group: 'Patients' }),
    as(S.medicalRecords, { group: 'Patients' }),
    as(S.doctorProfile, { group: 'Practice' }),
    as(S.account, { group: 'Practice' }),
  ],
  [ROLES.CLINIC_ADMIN]: [
    as(S.dashboard, { label: 'Clinic overview', group: 'Clinic' }),
    as(S.appointments, {
      label: 'Clinic schedule',
      group: 'Clinic',
      description: 'Every appointment at your clinic, day by day.',
    }),
    as(S.clinic, {
      label: 'Doctors & team',
      group: 'Clinic',
      description: 'Clinic details, the doctors practising here and membership.',
    }),
    as(S.account, { group: 'Account' }),
  ],
  [ROLES.PLATFORM_ADMIN]: [
    as(S.dashboard, { group: 'Administration' }),
    as(S.verification, { group: 'Administration' }),
    as(S.clinics, { group: 'Administration' }),
    as(S.users, { group: 'Administration' }),
    as(S.audit, { group: 'Oversight' }),
    as(S.operations, { group: 'Oversight' }),
    as(S.account, { group: 'Account' }),
  ],
  // No appointment console exists for support yet, so it is not offered (no dead end).
  [ROLES.SUPPORT]: [
    as(S.dashboard, { group: 'Support' }),
    as(S.users, {
      label: 'User lookup',
      group: 'Support',
      description: 'Find an account to help a user.',
    }),
    as(S.account, { group: 'Account' }),
  ],
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

/** True if the permission is held globally or for any clinic (UI hint only). */
export function userHasPermission(user, permission) {
  if (user.permissions.includes(permission)) return true;
  return Object.values(user.clinicPermissions ?? {}).some((perms) => perms.includes(permission));
}

/** Navigation for a user: their primary role's items that their permissions allow. */
export function navigationFor(user) {
  const items = ROLE_NAVIGATION[primaryRole(user.roles)] ?? [];
  return items.filter((item) => !item.permission || userHasPermission(user, item.permission));
}

/** The navigation entry for a path (for "where am I" labels), using the user's wording. */
export function sectionForPath(user, pathname) {
  const rest = pathname.replace(/^\/app\/?/, '');
  return navigationFor(user)
    .filter((item) => item.path && (rest === item.path || rest.startsWith(`${item.path}/`)))
    .sort((a, b) => b.path.length - a.path.length)[0];
}
