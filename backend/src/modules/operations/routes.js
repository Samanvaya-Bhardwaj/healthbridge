import { Router } from 'express';
import { z } from 'zod';
import { PERMISSIONS } from '@healthbridge/shared';
import { validate } from '../../core/http/validate.js';

/** /admin/operations/*: background-job health and dead letters (operations:manage). */
export function operationsRoutes(container) {
  const { authenticate, accessPolicy, operationsService } = container;
  const router = Router();
  const can = [authenticate(), accessPolicy.requirePermission(PERMISSIONS.OPERATIONS_MANAGE)];

  router.get('/admin/operations/summary', can, async (_req, res) => {
    res.json({ data: await operationsService.summary() });
  });
  router.get(
    '/admin/operations/dead-letters',
    can,
    validate({
      query: z
        .object({
          status: z.enum(['open', 'retried', 'resolved']).default('open'),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        })
        .strict(),
    }),
    async (req, res) => {
      res.json({ data: await operationsService.listDeadLetters(req.valid.query) });
    },
  );
  router.post(
    '/admin/operations/dead-letters/:id/retry',
    can,
    validate({ params: z.object({ id: z.string().max(64) }) }),
    async (req, res) => {
      res.json({
        data: await operationsService.retryDeadLetter(req.principal, req.valid.params.id, req),
      });
    },
  );
  return router;
}
