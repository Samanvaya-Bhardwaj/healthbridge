import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createHarness } from './harness.js';

let h;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

/**
 * Every route an anonymous caller may reach (OWASP A01: deny by default). Anything else
 * must answer 401 without a session. Adding a public route means adding it here,
 * deliberately.
 */
const PUBLIC = new Set([
  'GET /meta',
  'POST /auth/register',
  'POST /auth/login',
  'POST /auth/refresh', // refresh cookie + CSRF instead of a bearer token
  'POST /auth/logout', // refresh cookie + CSRF
  'POST /auth/password/forgot',
  'POST /auth/password/reset', // the emailed single-use token is the credential
  'POST /auth/email/verify', // likewise
  'POST /telemetry/client-errors', // error class + route only
  'GET /doctors', // public directory of verified doctors
  'GET /doctors/:doctorId', // public profile of a verified doctor
  'GET /doctors/:doctorId/slots', // public availability
]);

/** Walks the Express router stacks for the /api/v1 routes. */
function collectRoutes(stack, prefix = '') {
  const routes = [];
  for (const layer of stack) {
    if (layer.route) {
      for (const method of Object.keys(layer.route.methods)) {
        if (method !== '_all') routes.push(`${method.toUpperCase()} ${prefix}${layer.route.path}`);
      }
    } else if (layer.handle?.stack) {
      routes.push(...collectRoutes(layer.handle.stack, prefix));
    }
  }
  return routes;
}

describe('route inventory (deny by default)', () => {
  it('every non-public API route rejects anonymous callers with 401', async () => {
    const { apiV1Router } = await import('../../src/api/v1/index.js');
    const router = apiV1Router({ config: h.config, version: 'test', container: h.container });
    const routes = [...new Set(collectRoutes(router.stack))];
    expect(routes.length).toBeGreaterThan(100);

    const unexpected = [];
    for (const route of routes) {
      if (PUBLIC.has(route)) continue;
      const [method, path] = route.split(' ');
      const url = `/api/v1${path.replace(/:[A-Za-z]+/g, randomUUID())}`;
      const res = await request(h.app)[method.toLowerCase()](url).send({});
      if (res.status !== 401) unexpected.push(`${route} → ${res.status}`);
    }
    expect(unexpected).toEqual([]);
  });

  it('the public allowlist only names routes that exist', async () => {
    const { apiV1Router } = await import('../../src/api/v1/index.js');
    const router = apiV1Router({ config: h.config, version: 'test', container: h.container });
    const routes = new Set(collectRoutes(router.stack));
    expect([...PUBLIC].filter((r) => !routes.has(r))).toEqual([]);
  });
});
