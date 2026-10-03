import { Router } from 'express';
import { z } from 'zod';
import {
  consultationOutcomeSchema,
  noteCorrectionSchema,
  prescriptionCorrectionSchema,
  prescriptionDraftSchema,
  soapNoteSchema,
} from '@healthbridge/shared';
import { validate } from '../../core/http/validate.js';

const param = (name) => z.object({ [name]: z.string().max(64) });

/** Consultations and prescribing (ADR-0025). Services enforce every access decision. */
export function consultationRoutes(container) {
  const { authenticate, consultationService, prescriptionService } = container;
  const router = Router();
  const noStore = (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  };
  const appt = validate({ params: param('id') });
  const route = (method, path, middleware, handler, status = 200) =>
    router[method](path, authenticate(), noStore, ...middleware, async (req, res) => {
      res.status(status).json({ data: await handler(req) });
    });
  const P = (req) => [req.principal, req.valid.params.id];

  // ── Consultation ────────────────────────────────────────────────
  route('get', '/appointments/:id/consultation', [appt], (req) =>
    consultationService.view(...P(req), req),
  );
  route('get', '/appointments/:id/consultation/status', [appt], (req) =>
    consultationService.status(...P(req), req),
  );
  route('post', '/appointments/:id/waiting-room', [appt], (req) =>
    consultationService.arrive(...P(req), req),
  );
  route('post', '/appointments/:id/consultation/start', [appt], (req) =>
    consultationService.start(...P(req), req),
  );
  route('post', '/appointments/:id/consultation/join', [appt], (req) =>
    consultationService.join(...P(req), req),
  );
  route(
    'put',
    '/appointments/:id/consultation/note',
    [validate({ params: param('id'), body: soapNoteSchema })],
    (req) => consultationService.saveNote(...P(req), req.valid.body, req),
  );
  route('post', '/appointments/:id/consultation/note/sign', [appt], (req) =>
    consultationService.signNote(...P(req), req),
  );
  route(
    'post',
    '/clinical-notes/:id/corrections',
    [validate({ params: param('id'), body: noteCorrectionSchema })],
    (req) => consultationService.correctNote(...P(req), req.valid.body, req),
    201,
  );
  route(
    'post',
    '/appointments/:id/consultation/outcome',
    [validate({ params: param('id'), body: consultationOutcomeSchema })],
    (req) => consultationService.recordOutcome(...P(req), req.valid.body, req),
  );

  // ── Prescriptions ───────────────────────────────────────────────
  route(
    'put',
    '/appointments/:id/consultation/prescription',
    [validate({ params: param('id'), body: prescriptionDraftSchema })],
    (req) => prescriptionService.saveDraft(...P(req), req.valid.body, req),
  );
  route('post', '/prescriptions/:id/sign', [appt], (req) =>
    prescriptionService.sign(...P(req), req),
  );
  route(
    'post',
    '/prescriptions/:id/corrections',
    [validate({ params: param('id'), body: prescriptionCorrectionSchema })],
    (req) => prescriptionService.correct(...P(req), req.valid.body, req),
    201,
  );
  route('get', '/prescriptions/:id', [appt], (req) => prescriptionService.get(...P(req), req));
  route('post', '/prescriptions/:id/pdf-url', [appt], (req) =>
    prescriptionService.pdfUrl(...P(req), req),
  );
  route(
    'get',
    '/patients/:patientId/prescriptions',
    [validate({ params: param('patientId') })],
    (req) => prescriptionService.listForPatient(req.principal, req.valid.params.patientId, req),
  );

  return router;
}
