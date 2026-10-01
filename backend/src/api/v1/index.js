import { Router } from 'express';
import { API_VERSION } from '@healthbridge/shared';

/**
 * Versioned public API. Feature modules (identity, patients, scheduling, …) mount
 * their routers here as they are implemented.
 *
 * @param {{ config: ReturnType<typeof import('../../config/index.js').loadConfig>, version: string }} deps
 */
export function apiV1Router({ config, version }) {
  const router = Router();

  router.get('/meta', (_req, res) => {
    res.json({
      data: {
        name: 'HealthBridge API',
        apiVersion: API_VERSION,
        version,
        demoMode: config.demoMode,
      },
    });
  });

  return router;
}
