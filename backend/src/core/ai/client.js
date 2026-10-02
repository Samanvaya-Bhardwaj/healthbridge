import { SignJWT } from 'jose';
import { REQUEST_ID_HEADER } from '@healthbridge/shared';

export const SERVICE_TOKEN_ISSUER = 'healthbridge-api';
export const SERVICE_TOKEN_AUDIENCE = 'healthbridge-ai';
export const SCOPE_TOKEN_AUDIENCE = 'healthbridge-ai-scope';
const SERVICE_TOKEN_TTL_SECONDS = 60;
const SCOPE_TOKEN_TTL_SECONDS = 120;

/**
 * Client for the internal AI service. Every call carries a short-lived service JWT
 * (HS256, 60 s). Patient-data calls also carry a patient scope token (120 s) naming the
 * one patient — and documents — the backend authorised for the purpose (ADR-0022); the AI
 * service runs its database work confined to that patient by RLS.
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

  /** @param {{ patientId: string, purpose: string, documentIds?: string[] }} scope */
  async function scopeToken({ patientId, purpose, documentIds = [] }) {
    return new SignJWT({ typ: 'patient_scope', pid: patientId, purpose, docs: documentIds })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(SERVICE_TOKEN_ISSUER)
      .setAudience(SCOPE_TOKEN_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${SCOPE_TOKEN_TTL_SECONDS}s`)
      .sign(key);
  }

  async function request(
    path,
    { method = 'GET', body, requestId, timeout = timeoutMs, scope } = {},
  ) {
    const headers = { authorization: `Bearer ${await serviceToken()}`, accept: 'application/json' };
    if (scope) headers['x-patient-scope'] = await scopeToken(scope);
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
      // 4xx: the request itself is wrong (retrying cannot help); 5xx/timeouts: retry.
      error.retryable = response.status >= 500 || response.status === 429;
      throw error;
    }
    return response.json();
  }

  return {
    request,
    /** Authenticated round-trip: verifies reachability and internal auth together. */
    ping: (requestId) => request('/v1/meta', { requestId }),
    /** Document agent run for one authorised document (content sent, never stored here). */
    analyzeDocument: (input, { requestId } = {}) =>
      request('/v1/documents/analyze', {
        method: 'POST',
        body: input,
        requestId,
        timeout: 180_000,
        scope: {
          patientId: input.patientId,
          purpose: 'document_analysis',
          documentIds: [input.documentId],
        },
      }),
  };
}
