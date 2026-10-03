import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../core/http/validate.js';

const patientParam = z.object({ patientId: z.string().max(64) });

/** /patients/:patientId/timeline (+ export). */
export function timelineRoutes(container) {
  const { authenticate, timelineService } = container;
  const router = Router();
  router.get(
    '/patients/:patientId/timeline',
    authenticate(),
    validate({
      params: patientParam,
      query: z
        .object({
          cursor: z.string().max(200).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
          types: z
            .string()
            .max(60)
            .optional()
            .transform((v) => (v ? v.split(',') : undefined)),
        })
        .strict(),
    }),
    async (req, res) => {
      res.set('Cache-Control', 'no-store');
      const page = await timelineService.list(
        req.principal,
        req.valid.params.patientId,
        req.valid.query,
        req,
      );
      res.json({ data: page.items, meta: { nextCursor: page.nextCursor } });
    },
  );
  router.get(
    '/patients/:patientId/timeline/export',
    authenticate(),
    validate({ params: patientParam }),
    async (req, res) => {
      const body = await timelineService.exportTimeline(
        req.principal,
        req.valid.params.patientId,
        req,
      );
      res.set('Cache-Control', 'no-store');
      res.set('Content-Disposition', 'attachment; filename="healthbridge-timeline.json"');
      res.json(body);
    },
  );
  return router;
}
