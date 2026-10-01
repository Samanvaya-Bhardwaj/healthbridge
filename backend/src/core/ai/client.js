import { SignJWT } from 'jose';
import { REQUEST_ID_HEADER } from '@healthbridge/shared';

export const SERVICE_TOKEN_ISSUER = 'healthbridge-api';
export const SERVICE_TOKEN_AUDIENCE = 'healthbridge-ai';
const SERVICE_TOKEN_TTL_SECONDS = 60;

/**
 * Client for the internal AI service. Every call carries a short-lived service JWT
 * (HS256, 60 s). Per-request patient scope tokens are added with the first
 * patient-data AI features (see ADR-0006, ADR-0010).
 *
 * @param {{ url: string, internalSecret: string, timeoutMs?: number, fetchImpl?: typeof fetch }} options
 */
export function createAiClient({ url, internalSecret, timeoutMs = 5_000, fetchImpl = fetch }) {
  const key = new TextEncoder().encode(internalSecret);
  const baseUrl = url.replace(/\/+$/, '');

  async function serviceToken() {
    return new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(SERVICE_TOKEN_ISSUER)
      .setAudience(SERVICE_TOKEN_AUDIENCE)
      .setSubject(SERVICE_TOKEN_ISSUER)
      .setIssuedAt()
      .setExpirationTime(`${SERVICE_TOKEN_TTL_SECONDS}s`)
      .sign(key);
  }

  async function request(path, { method = 'GET', body, requestId, timeout = timeoutMs } = {}) {
    const headers = { authorization: `Bearer ${await serviceToken()}`, accept: 'application/json' };
    if (requestId) headers[REQUEST_ID_HEADER] = requestId;
    if (body !== undefined) headers['content-type'] = 'application/json';

    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) {
      const error = new Error(`AI service responded ${response.status} for ${method} ${path}`);
      error.name = 'AiServiceError';
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  return {
    request,
    /** Authenticated round-trip: verifies reachability and internal auth together. */
    ping: (requestId) => request('/v1/meta', { requestId }),
  };
}
