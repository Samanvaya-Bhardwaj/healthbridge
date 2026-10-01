import { API_BASE_PATH } from '@healthbridge/shared';

/** Normalised API error built from RFC 9457 problem details. */
export class ApiError extends Error {
  /** @param {{ status: number, code: string, title: string, detail?: string, requestId?: string, errors?: { path: string, message: string }[] }} problem */
  constructor({ status, code, title, detail, requestId, errors }) {
    super(detail ?? title);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.title = title;
    this.detail = detail;
    this.requestId = requestId;
    this.errors = errors ?? [];
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Thin fetch wrapper for the HealthBridge API: same-origin, JSON in/out,
 * consistent error shape. Authentication (in-memory access token + refresh
 * cookie) is added in M1.
 *
 * @param {string} path e.g. "/meta"
 * @param {{ method?: string, body?: unknown, signal?: AbortSignal, timeoutMs?: number }} [options]
 */
export async function apiRequest(
  path,
  { method = 'GET', body, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {},
) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';

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
    });
  }
  return payload;
}
