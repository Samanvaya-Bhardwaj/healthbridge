import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { z } from 'zod';
import { buildTestApp } from '../helpers.js';
import { validate } from '../../src/core/http/validate.js';
import { ConflictError } from '../../src/core/http/errors.js';
import { isUuidV7 } from '../../src/core/db/ids.js';

describe('request IDs', () => {
  it('generates a UUIDv7 request ID when none is supplied', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/api/v1/meta');
    expect(isUuidV7(res.headers['x-request-id'])).toBe(true);
  });

  it('propagates a well-formed upstream request ID', async () => {
    const { app } = buildTestApp();
    const id = 'a3f1c2d4e5b6a7980123456789abcdef';
    const res = await request(app).get('/api/v1/meta').set('X-Request-Id', id);
    expect(res.headers['x-request-id']).toBe(id);
  });

  it('replaces malformed request IDs (log-injection guard)', async () => {
    const { app } = buildTestApp();
    const res = await request(app)
      .get('/api/v1/meta')
      .set('X-Request-Id', 'bad id" INJECTED <script>');
    expect(res.headers['x-request-id']).not.toContain('INJECTED');
    expect(isUuidV7(res.headers['x-request-id'])).toBe(true);
  });
});

describe('API v1 meta', () => {
  it('returns API metadata', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/api/v1/meta');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: 'HealthBridge API', apiVersion: 'v1' });
  });
});

describe('error handling (problem+json)', () => {
  it('returns 404 problem details with the request ID for unknown routes', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/api/v1/does-not-exist?patient=secret');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body).toMatchObject({ status: 404, code: 'not_found' });
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
    expect(res.body.instance).toBe('/api/v1/does-not-exist');
  });

  it('rejects malformed JSON with 400', async () => {
    const { app } = buildTestApp();
    const res = await request(app)
      .post('/api/v1/meta')
      .set('content-type', 'application/json')
      .send('{"broken":');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('malformed_json');
  });

  it('rejects oversized bodies with 413', async () => {
    const { app } = buildTestApp();
    const res = await request(app)
      .post('/api/v1/meta')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ blob: 'a'.repeat(200_000) }));
    expect(res.status).toBe(413);
  });

  it('renders AppError subclasses and hides internals of unexpected errors', async () => {
    const express = (await import('express')).default;
    const { errorHandler } = await import('../../src/core/http/errorHandler.js');
    const app = express();
    app.get('/conflict', () => {
      throw new ConflictError('Slot already booked.', 'slot_unavailable');
    });
    app.get('/boom', () => {
      throw new Error('database password is hunter2');
    });
    app.use(errorHandler());

    const conflict = await request(app).get('/conflict');
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({
      code: 'slot_unavailable',
      detail: 'Slot already booked.',
    });

    const boom = await request(app).get('/boom');
    expect(boom.status).toBe(500);
    expect(boom.body.code).toBe('internal_error');
    expect(JSON.stringify(boom.body)).not.toContain('hunter2');
  });
});

describe('validate middleware', () => {
  it('exposes parsed values on req.valid and reports field errors', async () => {
    const express = (await import('express')).default;
    const { errorHandler } = await import('../../src/core/http/errorHandler.js');
    const app = express();
    app.use(express.json());
    app.post(
      '/items/:id',
      validate({
        params: z.object({ id: z.uuid() }),
        body: z.object({ quantity: z.coerce.number().int().positive() }).strict(),
      }),
      (req, res) => res.json(req.valid),
    );
    app.use(errorHandler());

    const id = '0192b6f0-0000-7000-8000-000000000000';
    const ok = await request(app).post(`/items/${id}`).send({ quantity: '3' });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ params: { id }, body: { quantity: 3 } });

    const bad = await request(app).post('/items/not-a-uuid').send({ quantity: -1, extra: true });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('validation_failed');
    const paths = bad.body.errors.map((e) => e.path);
    expect(paths).toEqual(expect.arrayContaining(['params.id', 'body.quantity']));
  });
});

describe('security headers', () => {
  it('sets restrictive headers and no X-Powered-By', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/api/v1/meta');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('allows configured CORS origins only', async () => {
    const { app } = buildTestApp();
    const allowed = await request(app).get('/api/v1/meta').set('Origin', 'http://localhost:5173');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    const denied = await request(app).get('/api/v1/meta').set('Origin', 'https://evil.example');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('logging', () => {
  it('logs request path without query string and never logs auth headers', async () => {
    const { app, logs } = buildTestApp();
    await request(app)
      .get('/api/v1/meta?search=patient-name')
      .set('Authorization', 'Bearer super-secret-token');
    const serialized = JSON.stringify(logs);
    expect(serialized).toContain('/api/v1/meta');
    expect(serialized).not.toContain('patient-name');
    expect(serialized).not.toContain('super-secret-token');
  });
});
