import { API_BASE_PATH } from '@healthbridge/shared';

const UUID_SEGMENT = /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi;
const MAX_REPORTS_PER_PAGE = 10;
let sent = 0;

/** The current route with identifiers replaced; never the query string or hash. */
export const routeTemplate = (pathname = window.location.pathname) =>
  pathname.replace(UUID_SEGMENT, '/:id').replace(/[^A-Za-z0-9/_:-]/g, '');

/**
 * Reports a browser error without its content (M11). Messages and stack traces can
 * include patient data shown on screen, so only the error class, kind and route are sent.
 * Best effort: failures are ignored and reports are capped per page load.
 * @param {'render_error' | 'unhandled_rejection' | 'window_error'} kind
 */
export function reportClientError(kind, error) {
  if (sent >= MAX_REPORTS_PER_PAGE || typeof fetch !== 'function') return;
  sent += 1;
  const name = typeof error?.name === 'string' ? error.name.slice(0, 60) : 'Error';
  fetch(`${API_BASE_PATH}/telemetry/client-errors`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind, name, path: routeTemplate() || '/' }),
    credentials: 'omit',
    keepalive: true,
  }).catch(() => {});
}

/** Global listeners for errors outside React rendering. */
export function installGlobalErrorReporting() {
  window.addEventListener('error', (event) => reportClientError('window_error', event.error));
  window.addEventListener('unhandledrejection', (event) =>
    reportClientError('unhandled_rejection', event.reason),
  );
}

/** Test helper. */
export const resetErrorReporting = () => {
  sent = 0;
};
