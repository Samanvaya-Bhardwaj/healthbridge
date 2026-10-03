import { API_BASE_PATH, CSRF_COOKIE, CSRF_HEADER } from '@healthbridge/shared';

/** Normalised API error built from RFC 9457 problem details. */
export class ApiError extends Error {
  /** @param {{ status: number, code: string, title: string, detail?: string, requestId?: string, errors?: { path: string, message: string }[], retryAfterSeconds?: number }} problem */
  constructor({ status, code, title, detail, requestId, errors, retryAfterSeconds }) {
    super(detail ?? title);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.title = title;
    this.detail = detail;
    this.requestId = requestId;
    this.errors = errors ?? [];
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;

// Cookie-authenticated endpoints: never send the bearer token, never auto-refresh.
const SESSION_ENDPOINTS = new Set([
  '/auth/login',
  '/auth/register',
  '/auth/refresh',
  '/auth/logout',
  // Account recovery is anonymous by design (the emailed link is the credential).
  '/auth/password/forgot',
  '/auth/password/reset',
  '/auth/email/verify',
]);
const CSRF_ENDPOINTS = new Set(['/auth/refresh', '/auth/logout']);

// Access token lives in memory only: never localStorage/sessionStorage (XSS exfiltration).
let accessToken = null;
let refreshHandler = null;

export const setAccessToken = (token) => {
  accessToken = token ?? null;
};
export const getAccessToken = () => accessToken;

/** Registers the function used to obtain a fresh access token after a 401. */
export const setRefreshHandler = (handler) => {
  refreshHandler = handler;
};

export function readCookie(name) {
  const match = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

export const hasSessionCookie = () => Boolean(readCookie(CSRF_COOKIE));

async function send(path, { method, body, signal, timeoutMs, extraHeaders }) {
  const headers = { accept: 'application/json', ...extraHeaders };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (accessToken && !SESSION_ENDPOINTS.has(path)) headers.authorization = `Bearer ${accessToken}`;
  if (CSRF_ENDPOINTS.has(path)) {
    const csrf = readCookie(CSRF_COOKIE);
    if (csrf) headers[CSRF_HEADER] = csrf;
  }

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetch(`${API_BASE_PATH}${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new ApiError({
      status: 0,
      code: err?.name === 'TimeoutError' ? 'timeout' : 'network_error',
      title: 'Network error',
      detail: 'We could not reach HealthBridge. Please check your connection and try again.',
    });
  }

  const requestId = response.headers.get('x-request-id') ?? undefined;
  if (response.status === 204) return null;
  const contentType = response.headers.get('content-type') ?? '';
  const payload = contentType.includes('json') ? await response.json().catch(() => null) : null;

  if (!response.ok) {
    throw new ApiError({
      status: response.status,
      code: payload?.code ?? 'http_error',
      title: payload?.title ?? response.statusText ?? 'Request failed',
      detail: payload?.detail ?? 'Something went wrong. Please try again.',
      requestId: payload?.requestId ?? requestId,
      errors: payload?.errors,
      retryAfterSeconds: payload?.retryAfterSeconds,
    });
  }
  return payload;
}

/**
 * HealthBridge API call: same-origin, JSON in/out, consistent errors. On a 401 from an
 * authenticated endpoint it refreshes the session once and retries.
 *
 * @param {string} path e.g. "/auth/me"
 * @param {{ method?: string, body?: unknown, signal?: AbortSignal, timeoutMs?: number, headers?: Record<string, string> }} [options]
 */
export async function apiRequest(
  path,
  { method = 'GET', body, signal, timeoutMs = DEFAULT_TIMEOUT_MS, headers } = {},
) {
  const options = { method, body, signal, timeoutMs, extraHeaders: headers };
  const hadToken = Boolean(accessToken);
  try {
    return await send(path, options);
  } catch (err) {
    const canRefresh =
      err instanceof ApiError &&
      err.status === 401 &&
      hadToken &&
      refreshHandler &&
      !SESSION_ENDPOINTS.has(path);
    if (!canRefresh || !(await refreshHandler())) throw err;
    return send(path, options);
  }
}
