import { vi } from 'vitest';
import { permissionsForRoles } from '@healthbridge/shared';

export const json = (status, body, headers = {}) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: {
      'content-type': status >= 400 ? 'application/problem+json' : 'application/json',
      ...headers,
    },
  });

export const problem = (status, code, detail = code) =>
  json(status, { status, code, title: code, detail });

export function makeUser(roles = ['PATIENT'], overrides = {}) {
  return {
    id: '0192b6f0-0000-7000-8000-000000000001',
    email: 'asha@demo.healthbridge.local',
    fullName: 'Asha Rao',
    roles,
    permissions: [...permissionsForRoles(roles)].sort(),
    clinicRoles: [],
    clinicPermissions: {},
    ...overrides,
  };
}

export const sessionPayload = (user, token = 'access-token-1') => ({
  data: {
    accessToken: token,
    tokenType: 'Bearer',
    expiresIn: 600,
    sessionExpiresAt: '2026-10-15T00:00:00Z',
    user,
  },
});

/**
 * Installs a fetch mock routing "METHOD /path" to handlers. Unrouted calls fail loudly.
 * @param {Record<string, (init: RequestInit) => Response | Promise<Response>>} routes
 */
export function fakeApi(routes) {
  const calls = [];
  const all = {
    'GET /api/v1/meta': () =>
      json(200, { data: { apiVersion: 'v1', version: '0.1.0', demoMode: false } }),
    ...routes,
  };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init = {}) => {
    const key = `${init.method ?? 'GET'} ${url}`;
    calls.push({ key, init });
    const handler = all[key];
    if (!handler) return problem(404, 'not_found', `unrouted ${key}`);
    return handler(init);
  });
  return calls;
}

export function setCookie(value) {
  document.cookie = value;
}

export function clearCookies() {
  for (const part of document.cookie.split(';')) {
    const name = part.split('=')[0].trim();
    if (name) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  }
}
