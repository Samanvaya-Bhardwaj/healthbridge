import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp } from '../helpers.js';
import { runHealthChecks } from '../../src/core/health/checks.js';

const up = async () => {};
const down = async () => {
  throw new Error('connection refused');
};
const hang = () => new Promise(() => {});

describe('GET /health/live', () => {
  it('returns 200 without touching dependencies', async () => {
    const { app } = buildTestApp({
      healthChecks: [{ name: 'database', critical: true, check: down }],
    });
    const res = await request(app).get('/health/live');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

describe('GET /health/ready', () => {
  it('is ok when all dependencies are up', async () => {
    const { app } = buildTestApp({
      healthChecks: [
        { name: 'database', critical: true, check: up },
        { name: 'aiService', critical: false, check: up },
      ],
    });
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.checks.database.status).toBe('up');
  });

  it('returns 503 when a critical dependency is down', async () => {
    const { app } = buildTestApp({
      healthChecks: [
        { name: 'database', critical: true, check: down },
        { name: 'aiService', critical: false, check: up },
      ],
    });
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('unavailable');
    expect(res.body.checks.database).toMatchObject({ status: 'down', error: 'connection refused' });
  });

  it('reports degraded (200) when only the AI service is down', async () => {
    const { app } = buildTestApp({
      healthChecks: [
        { name: 'database', critical: true, check: up },
        { name: 'aiService', critical: false, check: down },
      ],
    });
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded');
  });
});

describe('runHealthChecks', () => {
  it('times out hanging checks', async () => {
    const report = await runHealthChecks([{ name: 'redis', critical: true, check: hang }], 50);
    expect(report.status).toBe('unavailable');
    expect(report.checks.redis.error).toMatch(/timed out/);
  });
});
