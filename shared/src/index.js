// Shared constants and schemas: single definitions used by both frontend and backend.

export const API_VERSION = 'v1';
export const API_BASE_PATH = `/api/${API_VERSION}`;

/** Header used to correlate a request across Nginx, backend, workers and the AI service. */
export const REQUEST_ID_HEADER = 'x-request-id';

/** Header carrying the per-session CSRF token on cookie-authenticated auth endpoints. */
export const CSRF_HEADER = 'x-csrf-token';
/** Readable (non-httpOnly) cookie that delivers the CSRF token to the SPA. */
export const CSRF_COOKIE = 'hb_csrf';

export { ROLES, ROLE_LABELS } from './roles.js';
export {
  PERMISSIONS,
  PERMISSION_DESCRIPTIONS,
  ROLE_PERMISSIONS,
  PRIVILEGED_ROLES,
  ACCOUNT_LEVEL_PERMISSIONS,
  ROLE_SCOPES,
  WORKFLOW_GRANTED_ROLES,
  ALL_PERMISSIONS,
  ALL_ROLES,
  permissionsForRoles,
} from './auth/permissions.js';
export * from './auth/schemas.js';
export * from './domain/schemas.js';
export * from './domain/scheduling.js';
