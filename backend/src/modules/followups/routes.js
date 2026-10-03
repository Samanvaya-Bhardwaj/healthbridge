import { Router } from 'express';
import { z } from 'zod';
import {
  FOLLOW_UP_STATUSES,
  closeFollowUpSchema,
  createFollowUpSchema,
  followUpResponseSchema,
} from '@healthbridge/shared';
import { validate } from '../../core/http/validate.js';

const param = (name) => z.object({ [name]: z.string().max(64) });

/** Follow-ups and the in-app inbox (ADR-0026). Services enforce every access decision. */
export function followUpRoutes(container) {
  const { authenticate, followUpService, inboxService } = container;
  const router = Router();
  const noStore = (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  };
  const route = (method, path, middleware, handler, status = 200) =>
    router[method](path, authenticate(), noStore, ...middleware, async (req, res) => {
      const result = await handler(req);
      res.status(status).json(result?.data && result?.meta ? result : { data: result });
    });

  // ── Follow-ups ──────────────────────────────────────────────────
  route(
    'post',
    '/patients/:patientId/follow-ups',
    [validate({ params: param('patientId'), body: createFollowUpSchema })],
    (req) => followUpService.create(req.principal, req.valid.params.patientId, req.valid.body, req),
    201,
  );
  route(
    'get',
    '/patients/:patientId/follow-ups',
    [validate({ params: param('patientId') })],
    (req) => followUpService.listForPatient(req.principal, req.valid.params.patientId, req),
  );
  route(
    'get',
    '/doctors/me/follow-ups',
    [
      validate({
        query: z.object({ status: z.enum(['open', ...FOLLOW_UP_STATUSES]).optional() }).strict(),
      }),
    ],
    (req) => followUpService.listForDoctor(req.principal, req.valid.query, req),
  );
  route('get', '/follow-ups/:id', [validate({ params: param('id') })], (req) =>
    followUpService.get(req.principal, req.valid.params.id, req),
  );
  route(
    'post',
    '/follow-ups/:id/responses',
    [validate({ params: param('id'), body: followUpResponseSchema })],
    (req) => followUpService.respond(req.principal, req.valid.params.id, req.valid.body, req),
    201,
  );
  route(
    'post',
    '/follow-ups/:id/close',
    [validate({ params: param('id'), body: closeFollowUpSchema })],
    (req) => followUpService.close(req.principal, req.valid.params.id, req.valid.body, req),
  );

  // ── Inbox ───────────────────────────────────────────────────────
  route(
    'get',
    '/notifications',
    [
      validate({
        query: z
          .object({
            cursor: z.string().max(200).optional(),
            unread: z.enum(['true', 'false']).optional(),
            limit: z.coerce.number().int().min(1).max(50).optional(),
          })
          .strict(),
      }),
    ],
    (req) =>
      inboxService.list(
        req.principal,
        {
          cursor: req.valid.query.cursor,
          unreadOnly: req.valid.query.unread === 'true',
          limit: req.valid.query.limit,
        },
        req,
      ),
  );
  route('get', '/notifications/unread-count', [], (req) =>
    inboxService.unreadCount(req.principal, req),
  );
  route('post', '/notifications/read-all', [], (req) =>
    inboxService.markAllRead(req.principal, req),
  );
  route('post', '/notifications/:id/read', [validate({ params: param('id') })], (req) =>
    inboxService.markRead(req.principal, req.valid.params.id, req),
  );

  return router;
}
