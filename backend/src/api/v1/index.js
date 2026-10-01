import { Router } from 'express';
import { API_VERSION } from '@healthbridge/shared';
import { identityRoutes } from '../../modules/identity/routes.js';
import { adminRoutes } from '../../modules/admin/routes.js';
import { patientRoutes } from '../../modules/patients/routes.js';
import { careRoutes } from '../../modules/care/routes.js';
import { doctorRoutes } from '../../modules/doctors/routes.js';
import { clinicRoutes } from '../../modules/clinics/routes.js';

/**
 * Versioned public API. Feature modules mount their routers here.
 * Authentication and permissions are declared per route; nothing is public by accident:
 * only /meta, /auth/register, /auth/login, /auth/refresh and /auth/logout skip
 * Bearer authentication (refresh/logout are protected by cookie + CSRF instead).
 *
 * @param {{ config: ReturnType<typeof import('../../config/index.js').loadConfig>, version: string, container: ReturnType<typeof import('../../container.js').createContainer> }} deps
 */
export function apiV1Router({ config, version, container }) {
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

  router.use(identityRoutes(container));
  router.use(adminRoutes(container));
  router.use(patientRoutes(container));
  router.use(careRoutes(container));
  router.use(doctorRoutes(container));
  router.use(clinicRoutes(container));

  return router;
}
