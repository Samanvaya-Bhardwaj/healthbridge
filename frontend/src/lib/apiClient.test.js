import { describe, expect, it, vi } from 'vitest';
import { ApiError, apiRequest } from './apiClient.js';

const json = (body, init = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req-1' },
    ...init,
  });

describe('apiRequest', () => {
  it('calls the versioned API path and returns the JSON payload', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ data: { ok: true } }));
    await expect(apiRequest('/meta')).resolves.toEqual({ data: { ok: true } });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/meta',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('turns problem+json responses into ApiError', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 400,
          code: 'validation_failed',
          title: 'Validation failed',
          detail: 'The request contains invalid fields.',
          requestId: 'req-42',
          errors: [{ path: 'body.email', message: 'Invalid email' }],
        }),
        { status: 400, headers: { 'content-type': 'application/problem+json' } },
      ),
    );
    const error = await apiRequest('/x', { method: 'POST', body: {} }).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 400, code: 'validation_failed', requestId: 'req-42' });
    expect(error.errors).toHaveLength(1);
  });

  it('maps network failures to a friendly ApiError', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    const error = await apiRequest('/meta').catch((e) => e);
    expect(error).toMatchObject({ status: 0, code: 'network_error' });
  });
});
