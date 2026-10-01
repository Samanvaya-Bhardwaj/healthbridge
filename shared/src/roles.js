/** Platform roles (see docs/ARCHITECTURE.md and ADR-0006). */
export const ROLES = Object.freeze({
  PATIENT: 'PATIENT',
  DOCTOR: 'DOCTOR',
  CLINIC_ADMIN: 'CLINIC_ADMIN',
  PLATFORM_ADMIN: 'PLATFORM_ADMIN',
  SUPPORT: 'SUPPORT',
});

export const ROLE_LABELS = Object.freeze({
  PATIENT: 'Patient',
  DOCTOR: 'Doctor',
  CLINIC_ADMIN: 'Clinic administrator',
  PLATFORM_ADMIN: 'Platform administrator',
  SUPPORT: 'Support',
});
