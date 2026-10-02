import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../core/http/validate.js';

const id = (name) => z.object({ [name]: z.string().max(64) });
const noStore = (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};

/** Document intelligence (ADR-0022): AI proposals, verification, lab results, opt-in. */
export function intelligenceRoutes(container) {
  const { authenticate, intelligenceService } = container;
  const router = Router();

  router.get(
    '/documents/:id/extraction',
    authenticate(),
    noStore,
    validate({ params: id('id') }),
    async (req, res) => {
      res.json({
        data: await intelligenceService.getExtraction(req.principal, req.valid.params.id, req),
      });
    },
  );
  router.post(
    '/documents/:id/lab-results/verify',
    authenticate(),
    validate({
      params: id('id'),
      body: z
        .object({
          fieldKeys: z
            .array(z.string().regex(/^[a-z0-9_-]{1,64}$/))
            .min(1)
            .max(100),
        })
        .strict(),
    }),
    async (req, res) => {
      res.json({
        data: await intelligenceService.verifyLabResults(
          req.principal,
          req.valid.params.id,
          req.valid.body,
          req,
        ),
      });
    },
  );
  router.get(
    '/patients/:patientId/lab-results',
    authenticate(),
    noStore,
    validate({ params: id('patientId') }),
    async (req, res) => {
      res.json({
        data: await intelligenceService.listLabResults(
          req.principal,
          req.valid.params.patientId,
          req,
        ),
      });
    },
  );
  router.get(
    '/patients/:patientId/ai-processing',
    authenticate(),
    noStore,
    validate({ params: id('patientId') }),
    async (req, res) => {
      res.json({
        data: await intelligenceService.getAiProcessing(
          req.principal,
          req.valid.params.patientId,
          req,
        ),
      });
    },
  );
  router.put(
    '/patients/:patientId/ai-processing',
    authenticate(),
    validate({ params: id('patientId'), body: z.object({ enabled: z.boolean() }).strict() }),
    async (req, res) => {
      res.json({
        data: await intelligenceService.setAiProcessing(
          req.principal,
          req.valid.params.patientId,
          req.valid.body,
          req,
        ),
      });
    },
  );
  return router;
}
