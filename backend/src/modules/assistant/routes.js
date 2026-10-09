import { Router } from 'express';
import { z } from 'zod';
import {
  PERMISSIONS,
  assistantMessageSchema,
  assistantSessionCreateSchema,
} from '@healthbridge/shared';
import { validate } from '../../core/http/validate.js';
import { rateLimit } from '../../core/http/rateLimit.js';

const idParam = z.object({ id: z.string().max(64) });

/** /assistant/* — the HealthBridge Assistant (M13.1, ADR-0029). Patients and guardians. */
export function assistantRoutes(container) {
  const { authenticate, accessPolicy, assistantService, redis } = container;
  const router = Router();
  const can = [authenticate(), accessPolicy.requirePermission(PERMISSIONS.ASSISTANT_USE)];
  // Each turn may call a model: a per-user budget on top of the global limit.
  const budget = rateLimit({
    redis,
    keyPrefix: 'ai-assistant',
    points: 120,
    durationSeconds: 3600,
    key: (req) => req.principal?.userId ?? req.ip,
  });
  const noStore = (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  };

  router.post(
    '/assistant/sessions',
    can,
    noStore,
    budget,
    validate({ body: assistantSessionCreateSchema }),
    async (req, res) => {
      res
        .status(201)
        .json({ data: await assistantService.createSession(req.principal, req.valid.body, req) });
    },
  );
  router.get(
    '/assistant/sessions/:id',
    can,
    noStore,
    validate({ params: idParam }),
    async (req, res) => {
      res.json({
        data: await assistantService.getSession(req.principal, req.valid.params.id, req),
      });
    },
  );
  router.post(
    '/assistant/sessions/:id/messages',
    can,
    noStore,
    budget,
    validate({ params: idParam, body: assistantMessageSchema }),
    async (req, res) => {
      res.json({
        data: await assistantService.sendMessage(
          req.principal,
          req.valid.params.id,
          req.valid.body,
          req,
        ),
      });
    },
  );
  router.delete(
    '/assistant/sessions/:id',
    can,
    noStore,
    validate({ params: idParam }),
    async (req, res) => {
      await assistantService.endSession(req.principal, req.valid.params.id);
      res.status(204).end();
    },
  );
  return router;
}
