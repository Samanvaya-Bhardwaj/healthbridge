import { Router } from 'express';
import { z } from 'zod';
import { PERMISSIONS, careInvitationSchema, careRequestSchema } from '@healthbridge/shared';
import { validate } from '../../core/http/validate.js';
import { rateLimit } from '../../core/http/rateLimit.js';
import { CARE_ACTIONS } from './domain/stateMachine.js';

/**
 * /care-relationships/* and /doctors/me/patients routes.
 * @param {ReturnType<typeof import('../../container.js').createContainer>} container
 */
export function careRoutes(container) {
  const { authenticate, accessPolicy, careService, redis, rateLimits } = container;
  const router = Router();
  const can = (permission) => [authenticate(), accessPolicy.requirePermission(permission)];

  router.get(
    '/care-relationships',
    can(PERMISSIONS.CARE_RELATIONSHIPS_READ),
    validate({ query: z.object({ patientId: z.string().max(64).optional() }).strict() }),
    async (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.json({
        data: await careService.listForPatient(req.principal, req.valid.query.patientId, req),
      });
    },
  );

  router.post(
    '/care-relationships',
    can(PERMISSIONS.CARE_RELATIONSHIPS_MANAGE),
    validate({ body: careRequestSchema }),
    async (req, res) => {
      res.status(201).json({ data: await careService.request(req.principal, req.valid.body, req) });
    },
  );

  router.post(
    '/care-relationships/invitations',
    can(PERMISSIONS.CARE_RELATIONSHIPS_MANAGE),
    rateLimit({
      redis,
      keyPrefix: 'care-invite',
      ...rateLimits.careInvite,
      key: (req) => req.principal.userId,
    }),
    validate({ body: careInvitationSchema }),
    async (req, res) => {
      res.status(202).json({ data: await careService.invite(req.principal, req.valid.body, req) });
    },
  );

  router.post(
    '/care-relationships/:relationshipId/:action',
    can(PERMISSIONS.CARE_RELATIONSHIPS_MANAGE),
    validate({
      params: z.object({ relationshipId: z.string().max(64), action: z.enum(CARE_ACTIONS) }),
    }),
    async (req, res) => {
      const { relationshipId, action } = req.valid.params;
      res.json({ data: await careService.act(req.principal, relationshipId, action, req) });
    },
  );

  router.get(
    '/doctors/me/patients',
    can(PERMISSIONS.CARE_RELATIONSHIPS_READ),
    validate({
      query: z
        .object({ status: z.enum(['invited', 'pending', 'active', 'paused']).optional() })
        .strict(),
    }),
    async (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.json({ data: await careService.listForDoctor(req.principal, req.valid.query, req) });
    },
  );

  return router;
}
