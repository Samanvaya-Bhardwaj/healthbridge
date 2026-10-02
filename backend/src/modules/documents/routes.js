import { Router } from 'express';
import { z } from 'zod';
import { uploadIntentSchema } from '@healthbridge/shared';
import { validate } from '../../core/http/validate.js';

const id = z.object({ id: z.string().max(64) });
const noStore = (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};

/**
 * Medical documents (ADR-0021). Metadata and short-lived signed URLs only — the API
 * never streams document content and never returns storage keys or credentials.
 */
export function documentRoutes(container) {
  const { authenticate, documentService } = container;
  const router = Router();

  router.post(
    '/patients/:patientId/documents/upload-intent',
    authenticate(),
    noStore,
    validate({ params: z.object({ patientId: z.string().max(64) }), body: uploadIntentSchema }),
    async (req, res) => {
      res.status(201).json({
        data: await documentService.createUploadIntent(
          req.principal,
          req.valid.params.patientId,
          req.valid.body,
          req,
        ),
      });
    },
  );
  router.get(
    '/patients/:patientId/documents',
    authenticate(),
    noStore,
    validate({
      params: z.object({ patientId: z.string().max(64) }),
      query: z.object({ includeRetired: z.stringbool().default(false) }).strict(),
    }),
    async (req, res) => {
      res.json({
        data: await documentService.list(
          req.principal,
          req.valid.params.patientId,
          req.valid.query,
          req,
        ),
      });
    },
  );
  router.post(
    '/documents/:id/complete',
    authenticate(),
    validate({ params: id, body: z.object({}).strict() }),
    async (req, res) => {
      res.json({ data: await documentService.complete(req.principal, req.valid.params.id, req) });
    },
  );
  router.get(
    '/documents/:id',
    authenticate(),
    noStore,
    validate({ params: id }),
    async (req, res) => {
      res.json({ data: await documentService.get(req.principal, req.valid.params.id, req) });
    },
  );
  router.get(
    '/documents/:id/download',
    authenticate(),
    noStore,
    validate({ params: id }),
    async (req, res) => {
      res.json({ data: await documentService.download(req.principal, req.valid.params.id, req) });
    },
  );
  router.post(
    '/documents/:id/retire',
    authenticate(),
    validate({ params: id, body: z.object({}).strict() }),
    async (req, res) => {
      res.json({ data: await documentService.retire(req.principal, req.valid.params.id, req) });
    },
  );
  return router;
}
