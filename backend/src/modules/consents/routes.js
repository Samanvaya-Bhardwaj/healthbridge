import { Router } from 'express';
import { z } from 'zod';
import { grantConsentSchema, revokeConsentSchema } from '@healthbridge/shared';
import { validate } from '../../core/http/validate.js';

const noStore = (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};

/**
 * Consents and the patient access log (ADR-0021). Gates are evaluated in the services
 * with the patient in scope; routes only authenticate and validate.
 */
export function consentRoutes(container) {
  const { authenticate, consentService, accessLogService } = container;
  const router = Router();

  router.post(
    '/consents',
    authenticate(),
    validate({ body: grantConsentSchema }),
    async (req, res) => {
      res
        .status(201)
        .json({ data: await consentService.grant(req.principal, req.valid.body, req) });
    },
  );
  router.get(
    '/consents',
    authenticate(),
    noStore,
    validate({ query: z.object({ patientId: z.string().max(64) }).strict() }),
    async (req, res) => {
      res.json({
        data: await consentService.listForPatient(req.principal, req.valid.query.patientId, req),
      });
    },
  );
  router.get('/consents/received', authenticate(), noStore, async (req, res) => {
    res.json({ data: await consentService.listReceived(req.principal, req) });
  });
  router.post(
    '/consents/:id/revoke',
    authenticate(),
    validate({ params: z.object({ id: z.string().max(64) }), body: revokeConsentSchema }),
    async (req, res) => {
      res.json({
        data: await consentService.revoke(req.principal, req.valid.params.id, req.valid.body, req),
      });
    },
  );

  router.get(
    '/patients/:patientId/access-log',
    authenticate(),
    noStore,
    validate({
      params: z.object({ patientId: z.string().max(64) }),
      query: z
        .object({
          cursor: z.string().max(200).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(30),
        })
        .strict(),
    }),
    async (req, res) => {
      const page = await accessLogService.list(
        req.principal,
        req.valid.params.patientId,
        req.valid.query,
        req,
      );
      res.json({ data: page.items, meta: { nextCursor: page.nextCursor } });
    },
  );
  return router;
}
