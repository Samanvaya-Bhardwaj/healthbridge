import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { authHeader, createHarness, createUser, testRedisConfig } from './harness.js';
import { createQueues } from '../../src/core/queue/queues.js';
import { createBullBoardApp } from '../../src/core/queue/bullBoard.js';
import { domainMetrics } from '../../src/core/metrics/domain.js';

let h;
let admin;
beforeAll(async () => {
  h = await createHarness();
  admin = await createUser(h, { label: 'm11-admin', roles: ['PLATFORM_ADMIN'] });
});
afterAll(async () => {
  await h.close();
});

const counterValue = async (metric, labels) =>
  (await metric.get()).values
    .filter((v) => Object.entries(labels).every(([k, val]) => v.labels[k] === val))
    .reduce((sum, v) => sum + v.value, 0);

describe('audit viewer filters (M11)', () => {
  it('filters by patient and resource type, and rejects malformed filters', async () => {
    const patientId = randomUUID();
    await h.knex('audit.audit_logs').insert([
      {
        category: 'data_access',
        action: 'document.download',
        outcome: 'success',
        actor_type: 'user',
        resource_type: 'medical_document',
        resource_id: randomUUID(),
        patient_id: patientId,
      },
      {
        category: 'data_access',
        action: 'timeline.read',
        outcome: 'denied',
        actor_type: 'user',
        resource_type: 'timeline',
        patient_id: patientId,
      },
    ]);
    const get = (qs) =>
      request(h.app).get(`/api/v1/admin/audit-logs?${qs}`).set(authHeader(admin.session));

    const byPatient = await get(`patientId=${patientId}`);
    expect(byPatient.status).toBe(200);
    expect(byPatient.body.data.map((e) => e.action).sort()).toEqual([
      'document.download',
      'timeline.read',
    ]);
    const narrowed = await get(`patientId=${patientId}&resourceType=timeline&outcome=denied`);
    expect(narrowed.body.data).toHaveLength(1);
    expect(narrowed.body.data[0]).toMatchObject({ action: 'timeline.read', patientId });

    expect((await get('patientId=not-a-uuid')).status).toBe(400);
    expect((await get('action=DROP%20TABLE')).status).toBe(400);
    expect((await get('resourceType=a;b')).status).toBe(400);
  });
});

describe('support role (M11)', () => {
  it('can look up accounts but cannot change them, read the audit trail or run operations', async () => {
    const support = await createUser(h, { label: 'm11-support', roles: ['SUPPORT'] });
    const target = await createUser(h, { label: 'm11-target' });
    const as = (method, path, body) =>
      request(h.app)[method](`/api/v1${path}`).set(authHeader(support.session)).send(body);

    const list = await as('get', '/admin/users?q=m11-target');
    expect(list.status).toBe(200);
    expect(list.body.data.map((u) => u.id)).toContain(target.id);
    expect((await as('get', `/admin/users/${target.id}`)).status).toBe(200);
    expect(
      (
        await as('patch', `/admin/users/${target.id}/status`, {
          status: 'disabled',
          reasonCode: 'other',
        })
      ).status,
    ).toBe(403);
    expect((await as('put', `/admin/users/${target.id}/roles/SUPPORT`)).status).toBe(403);
    expect((await as('post', `/admin/users/${target.id}/sessions/revoke`)).status).toBe(403);
    expect((await as('get', '/admin/audit-logs')).status).toBe(403);
    expect((await as('get', '/admin/operations/summary')).status).toBe(403);
    // Account administration never opens clinical records.
    expect((await as('get', `/patients/${randomUUID()}/timeline`)).status).toBeOneOf([403, 404]);
  });
});

describe('browser error reporting (M11)', () => {
  it('counts the error class and route only, and refuses content', async () => {
    const id = randomUUID();
    const before = await counterValue(domainMetrics.clientErrors, {
      kind: 'render_error',
      name: 'TypeError',
    });
    const ok = await request(h.app)
      .post('/api/v1/telemetry/client-errors')
      .send({ kind: 'render_error', name: 'TypeError', path: `/app/medical-records/${id}` });
    expect(ok.status).toBe(204);
    expect(
      await counterValue(domainMetrics.clientErrors, { kind: 'render_error', name: 'TypeError' }),
    ).toBe(before + 1);
    const line = h.logs.findLast((l) => l.msg === 'client error reported');
    expect(line).toMatchObject({ path: '/app/medical-records/:id', name: 'TypeError' });
    expect(JSON.stringify(line)).not.toContain(id);

    // Unknown classes collapse to "Other" (bounded labels).
    await request(h.app)
      .post('/api/v1/telemetry/client-errors')
      .send({ kind: 'window_error', name: 'PatientAsthmaError', path: '/app' })
      .expect(204);
    expect(await counterValue(domainMetrics.clientErrors, { name: 'PatientAsthmaError' })).toBe(0);

    // Messages, stacks and query strings are rejected outright.
    for (const body of [
      { kind: 'render_error', name: 'Error', path: '/app', message: 'Asha has asthma' },
      { kind: 'render_error', name: 'Error', path: '/app?q=asthma' },
      { kind: 'render_error', name: 'Error', path: '/app', stack: 'at Timeline' },
      { kind: 'other', name: 'Error', path: '/app' },
    ]) {
      expect((await request(h.app).post('/api/v1/telemetry/client-errors').send(body)).status).toBe(
        400,
      );
    }
  });
});

describe('Bull Board (M11)', () => {
  const credentials = { username: 'ops', password: 'test-board-password-0001' };
  let queues;
  let board;
  const logs = [];
  beforeAll(() => {
    queues = createQueues({
      redis: testRedisConfig(),
      prefix: `hbt-board-${randomUUID().slice(0, 6)}`,
    });
    board = createBullBoardApp({
      queues,
      ...credentials,
      logger: { warn: (obj, msg) => logs.push({ ...obj, msg }) },
    });
  });
  afterAll(async () => {
    await queues.close();
  });

  it('requires credentials and never logs what was supplied', async () => {
    expect((await request(board).get('/api/queues')).status).toBe(401);
    const wrong = await request(board).get('/api/queues').auth('ops', 'guess-password-123456');
    expect(wrong.status).toBe(401);
    expect(wrong.headers['www-authenticate']).toMatch(/^Basic /);
    expect(JSON.stringify(logs)).not.toContain('guess-password');
    const ok = await request(board)
      .get('/api/queues?page=1&jobsPerPage=1')
      .auth(credentials.username, credentials.password);
    expect(ok.status).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(ok.body.queues.every((q) => q.readOnlyMode)).toBe(true);
  });

  it('is read-only: retries go through the audited admin API instead', async () => {
    const res = await request(board)
      .put('/api/queues/notifications/retry/failed')
      .auth(credentials.username, credentials.password);
    expect(res.status).toBe(405);
  });
});
