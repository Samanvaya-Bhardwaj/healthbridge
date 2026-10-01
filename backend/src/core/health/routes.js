import { Router } from 'express';
import { runHealthChecks } from './checks.js';

/**
 * Liveness: the process is up and serving requests (no dependency checks, so a
 * database outage never causes the orchestrator to restart healthy API pods).
 * Readiness: all critical dependencies are reachable.
 *
 * These routes are not proxied by the public Nginx; they are for the container
 * runtime and internal monitoring only.
 *
 * @param {{ checks: import('./checks.js').HealthCheck[], version: string }} deps
 */
export function healthRoutes({ checks, version }) {
  const router = Router();

  router.get('/health/live', (_req, res) => {
    res.json({ status: 'ok', version, uptimeSeconds: Math.round(process.uptime()) });
  });

  router.get('/health/ready', async (_req, res) => {
    const report = await runHealthChecks(checks);
    res.status(report.status === 'unavailable' ? 503 : 200).json({ ...report, version });
  });

  return router;
}
