#!/usr/bin/env node
// Post-deploy smoke test (ADR-0028). Read-only: creates nothing, changes nothing.
//
//   node infra/deploy/smoke.mjs https://staging.example.org [--expect-version v1.2.3]
//
// Checks the public edge exactly as a browser sees it: TLS and redirect, the SPA shell
// and its security headers, the API through the edge, deny-by-default authentication,
// and that internal surfaces (metrics, health details, queues) are not exposed.
// Exits non-zero on the first failure. For rehearsals with a self-signed certificate,
// run with NODE_EXTRA_CA_CERTS pointing at that certificate.
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { 'expect-version': { type: 'string' }, retries: { type: 'string', default: '20' } },
});
const base = (positionals[0] ?? '').replace(/\/$/, '');
if (!/^https:\/\//.test(base)) {
  console.error('usage: smoke.mjs https://host[:port] [--expect-version vX]');
  process.exit(2);
}

const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
  } catch (err) {
    results.push({ name, ok: false, detail: err.message });
  }
}
const expect = (cond, message) => {
  if (!cond) throw new Error(message);
};
const get = (path, init) => fetch(`${base}${path}`, { redirect: 'manual', ...init });

// Wait for the edge to answer (fresh deployments warm up).
for (let i = 0; i < Number(values.retries); i += 1) {
  try {
    if ((await get('/healthz')).ok) break;
  } catch {
    // not up yet
  }
  await new Promise((resolve) => setTimeout(resolve, 3_000));
}

await check('edge health over TLS', async () => {
  const res = await get('/healthz');
  expect(res.status === 200, `status ${res.status}`);
});

await check('plain HTTP redirects to HTTPS', async () => {
  const url = new URL(base);
  const httpPort = process.env.SMOKE_HTTP_PORT ?? '80';
  const res = await fetch(`http://${url.hostname}:${httpPort}/app`, { redirect: 'manual' });
  expect(res.status === 301, `status ${res.status}`);
  expect(res.headers.get('location')?.startsWith('https://'), 'redirect is not https');
});

await check('SPA shell with security headers', async () => {
  const res = await get('/');
  expect(res.status === 200, `status ${res.status}`);
  const body = await res.text();
  expect(body.includes('<div id="root">'), 'SPA root missing');
  const h = res.headers;
  expect(h.get('strict-transport-security')?.includes('max-age='), 'no HSTS');
  expect(h.get('content-security-policy')?.includes("frame-ancestors 'none'"), 'weak CSP');
  expect(!h.get('content-security-policy')?.includes('__HB_'), 'unrendered CSP placeholder');
  expect(h.get('x-content-type-options') === 'nosniff', 'no nosniff');
  expect(!/\d/.test(h.get('server') ?? ''), 'server version disclosed');
  return 'HSTS, CSP, nosniff';
});

await check('API through the edge', async () => {
  const res = await get('/api/v1/meta');
  expect(res.status === 200, `status ${res.status}`);
  const { data } = await res.json();
  expect(data.apiVersion === 'v1', 'unexpected API version');
  if (values['expect-version']) {
    expect(data.version === values['expect-version'].replace(/^v/, ''), `version ${data.version}`);
  }
  return `api ${data.version}, demo ${data.demoMode}`;
});

await check('protected endpoints deny anonymous callers', async () => {
  for (const path of ['/api/v1/auth/me', '/api/v1/admin/users', '/api/v1/patients/me']) {
    const res = await get(path);
    expect(res.status === 401, `${path} → ${res.status}`);
  }
});

await check('unsigned payment webhooks are rejected', async () => {
  const res = await get('/api/v1/webhooks/payments/razorpay', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"event":"payment.captured"}',
  });
  expect([400, 401, 404].includes(res.status), `status ${res.status}`);
});

await check('internal surfaces are not public', async () => {
  for (const path of ['/metrics', '/health/ready', '/api/queues', '/api/v1/metrics']) {
    const body = await (await get(path)).text();
    expect(!/process_cpu_seconds_total|"checks"|bull-board/.test(body), `${path} exposed`);
  }
});

for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ` (${r.detail})` : ''}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `${failed} check(s) failed` : `all ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
