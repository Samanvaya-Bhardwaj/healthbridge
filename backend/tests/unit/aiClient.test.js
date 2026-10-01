import { describe, expect, it } from 'vitest';
import { jwtVerify } from 'jose';
import {
  createAiClient,
  SERVICE_TOKEN_AUDIENCE,
  SERVICE_TOKEN_ISSUER,
} from '../../src/core/ai/client.js';

const secret = 's'.repeat(48);

describe('AI service client', () => {
  it('sends a short-lived service JWT and propagates the request ID', async () => {
    let captured;
    const fetchImpl = async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify({ service: 'healthbridge-ai' }), { status: 200 });
    };
    const client = createAiClient({ url: 'http://ai:8000/', internalSecret: secret, fetchImpl });

    const body = await client.ping('req-0123456789abcdef');

    expect(body.service).toBe('healthbridge-ai');
    expect(captured.url).toBe('http://ai:8000/v1/meta');
    expect(captured.init.headers['x-request-id']).toBe('req-0123456789abcdef');

    const token = captured.init.headers.authorization.replace('Bearer ', '');
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      issuer: SERVICE_TOKEN_ISSUER,
      audience: SERVICE_TOKEN_AUDIENCE,
    });
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(60);
  });

  it('throws a typed error on non-2xx responses', async () => {
    const fetchImpl = async () => new Response('{}', { status: 401 });
    const client = createAiClient({ url: 'http://ai:8000', internalSecret: secret, fetchImpl });
    await expect(client.ping()).rejects.toMatchObject({ name: 'AiServiceError', status: 401 });
  });
});
