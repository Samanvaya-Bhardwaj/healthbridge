import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../core/http/validate.js';
import { rateLimit } from '../../core/http/rateLimit.js';

const id = (name) => z.object({ [name]: z.string().max(64) });

/** Doctor AI assistance (ADR-0024): record questions, briefs, feedback. */
export function assistRoutes(container) {
  const { authenticate, assistService, redis } = container;
  const router = Router();
  // Model calls cost money and load: a per-user budget on top of the global limit.
  const aiBudget = rateLimit({
    redis,
    keyPrefix: 'ai-assist',
    points: 60,
    durationSeconds: 3600,
    key: (req) => req.principal?.userId ?? req.ip,
  });

  router.post(
    '/patients/:patientId/record-questions',
    authenticate(),
    aiBudget,
    validate({
      params: id('patientId'),
      body: z.object({ question: z.string().trim().min(3).max(500) }).strict(),
    }),
    async (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.json({
        data: await assistService.ask(
          req.principal,
          req.valid.params.patientId,
          req.valid.body,
          req,
        ),
      });
    },
  );
  router.post(
    '/appointments/:id/brief',
    authenticate(),
    aiBudget,
    validate({
      params: id('id'),
      body: z.object({ refresh: z.boolean().default(false) }).strict(),
    }),
    async (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.json({
        data: await assistService.brief(req.principal, req.valid.params.id, req.valid.body, req),
      });
    },
  );
  router.post(
    '/briefs/:id/feedback',
    authenticate(),
    validate({
      params: id('id'),
      body: z
        .object({
          rating: z.enum(['helpful', 'not_helpful']),
          issue: z
            .enum([
              'missing_information',
              'incorrect_citation',
              'not_relevant',
              'too_long',
              'other',
            ])
            .optional(),
        })
        .strict(),
    }),
    async (req, res) => {
      res.json({
        data: await assistService.feedback(req.principal, req.valid.params.id, req.valid.body, req),
      });
    },
  );
  return router;
}
