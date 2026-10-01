import { Router } from 'express';
import { z } from 'zod';
import { PERMISSIONS, clinicSchema } from '@healthbridge/shared';
import { validate } from '../../core/http/validate.js';
import { paginationQuery } from '../../core/http/pagination.js';

const clinicParam = z.object({ clinicId: z.uuid() });
const membershipParams = clinicParam.extend({ membershipId: z.string().max(64) });

/**
 * /clinics/* (clinic-scoped management) and /admin/clinics/* (platform) routes.
 * @param {ReturnType<typeof import('../../container.js').createContainer>} container
 */
export function clinicRoutes(container) {
  const { authenticate, accessPolicy, clinicService } = container;
  const router = Router();
  const can = (permission, options) => [
    authenticate(),
    accessPolicy.requirePermission(permission, options),
  ];

  // ── Platform administration ─────────────────────────────────────
  const platform = can(PERMISSIONS.ADMIN_CLINICS);
  router.post('/admin/clinics', platform, validate({ body: clinicSchema }), async (req, res) => {
    res
      .status(201)
      .json({ data: await clinicService.createClinic(req.principal, req.valid.body, req) });
  });
  router.get(
    '/admin/clinics',
    platform,
    validate({
      query: z
        .object({ ...paginationQuery, status: z.enum(['active', 'inactive']).optional() })
        .strict(),
    }),
    async (req, res) => {
      const page = await clinicService.listClinics(req.valid.query);
      res.json({ data: page.items, meta: { nextCursor: page.nextCursor } });
    },
  );
  router.patch(
    '/admin/clinics/:clinicId/status',
    platform,
    validate({
      params: clinicParam,
      body: z.object({ status: z.enum(['active', 'inactive']) }).strict(),
    }),
    async (req, res) => {
      res.json({
        data: await clinicService.setClinicStatus(
          req.principal,
          req.valid.params.clinicId,
          req.valid.body.status,
          req,
        ),
      });
    },
  );
  router.post(
    '/admin/clinics/:clinicId/admins',
    platform,
    validate({ params: clinicParam, body: z.object({ userId: z.uuid() }).strict() }),
    async (req, res) => {
      res.status(201).json({
        data: await clinicService.appointAdmin(
          req.principal,
          req.valid.params.clinicId,
          req.valid.body.userId,
          req,
        ),
      });
    },
  );

  // ── Clinic information and clinic-scoped management ─────────────
  router.get(
    '/clinics/:clinicId',
    can(PERMISSIONS.CLINICS_READ, { clinicParam: 'clinicId' }),
    validate({ params: clinicParam }),
    async (req, res) => {
      res.json({ data: await clinicService.getClinic(req.valid.params.clinicId) });
    },
  );
  // Gate 1 for these routes is checked in the service (clinic:manage for the clinic, or
  // admin:clinics); authentication is required here.
  router.get(
    '/clinics/:clinicId/members',
    authenticate(),
    validate({ params: clinicParam }),
    async (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.json({
        data: await clinicService.listMembers(req.principal, req.valid.params.clinicId, req),
      });
    },
  );
  router.post(
    '/clinics/:clinicId/doctors',
    authenticate(),
    validate({ params: clinicParam, body: z.object({ doctorId: z.uuid() }).strict() }),
    async (req, res) => {
      res.status(201).json({
        data: await clinicService.inviteDoctor(
          req.principal,
          req.valid.params.clinicId,
          req.valid.body.doctorId,
          req,
        ),
      });
    },
  );
  router.post(
    '/clinics/:clinicId/members/:membershipId/end',
    authenticate(),
    validate({ params: membershipParams }),
    async (req, res) => {
      const { clinicId, membershipId } = req.valid.params;
      res.json({
        data: await clinicService.endMembership(req.principal, clinicId, membershipId, req),
      });
    },
  );

  // ── Invitations answered by the invited doctor ──────────────────
  for (const [action, accept] of [
    ['accept', true],
    ['decline', false],
  ]) {
    router.post(
      `/clinic-memberships/:membershipId/${action}`,
      can(PERMISSIONS.DOCTOR_PROFILE_MANAGE),
      validate({ params: z.object({ membershipId: z.string().max(64) }) }),
      async (req, res) => {
        res.json({
          data: await clinicService.respondToInvitation(
            req.principal,
            req.valid.params.membershipId,
            accept,
            req,
          ),
        });
      },
    );
  }

  return router;
}
