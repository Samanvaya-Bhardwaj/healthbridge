// Shared constants. Domain schemas (Zod) are added here as features land, so that
// frontend forms and backend validation use a single definition.

export const API_VERSION = 'v1';
export const API_BASE_PATH = `/api/${API_VERSION}`;

/** Platform roles (see docs/ARCHITECTURE.md §Access control). */
export const ROLES = Object.freeze({
  PATIENT: 'PATIENT',
  DOCTOR: 'DOCTOR',
  CLINIC_ADMIN: 'CLINIC_ADMIN',
  PLATFORM_ADMIN: 'PLATFORM_ADMIN',
  SUPPORT: 'SUPPORT',
});

/** Header used to correlate a request across Nginx, backend, workers and the AI service. */
export const REQUEST_ID_HEADER = 'x-request-id';
