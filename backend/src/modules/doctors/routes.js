import { Router } from 'express';
import { z } from 'zod';
import {
  PERMISSIONS,
  VERIFICATION_REASON_CODES,
  doctorProfileSchema,
  doctorProfileUpdateSchema,
  verificationDecisionSchema,
} from '@healthbridge/shared';
import { validate } from '../../core/http/validate.js';
import { paginationQuery } from '../../core/http/pagination.js';

const idParam = (name) => z.object({ [name]: z.string().max(64) });

const directoryQuery = z
  .object({
    ...paginationQuery,
    q: z.string().trim().min(2).max(100).optional(),
    specialization: z.string().trim().min(2).max(80).optional(),
    clinicId: z.uuid().optional(),
  })
  .strict();

const queueQuery = z
  .object({
    status: z.enum(['pending', 'under_review', 'verified', 'rejected', 'suspended']).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

const suspendBody = z
  .object({
    reasonCode: z.enum(VERIFICATION_REASON_CODES.filter((c) => c !== 'credentials_confirmed')),
    notes: z.string().trim().max(1000).optional(),
  })
  .strict();

/**
 * /doctors/* (own profile, directory) and /admin/doctor-verifications/* routes.
 * @param {ReturnType<typeof import('../../container.js').createContainer>} container
 */
export function doctorRoutes(container) {
  const { authenticate, accessPolicy, doctorService, clinicService } = container;
  const router = Router();
  const can = (permission) => [authenticate(), accessPolicy.requirePermission(permission)];

  // ── Own doctor profile ──────────────────────────────────────────
  router.post(
    '/doctors/me',
    can(PERMISSIONS.DOCTOR_PROFILE_MANAGE),
    validate({ body: doctorProfileSchema }),
    async (req, res) => {
      res
        .status(201)
        .json({ data: await doctorService.createOwnProfile(req.principal, req.valid.body, req) });
    },
  );
  router.get('/doctors/me', can(PERMISSIONS.DOCTOR_PROFILE_MANAGE), async (req, res) => {
    res.json({ data: await doctorService.getOwnProfile(req.principal) });
  });
  router.patch(
    '/doctors/me',
    can(PERMISSIONS.DOCTOR_PROFILE_MANAGE),
    validate({ body: doctorProfileUpdateSchema }),
    async (req, res) => {
      res.json({ data: await doctorService.updateOwnProfile(req.principal, req.valid.body, req) });
    },
  );
  router.post(
    '/doctors/me/verification',
    can(PERMISSIONS.DOCTOR_PROFILE_MANAGE),
    async (req, res) => {
      res.status(201).json({ data: await doctorService.submitForVerification(req.principal, req) });
    },
  );
  router.get(
    '/doctors/me/verification',
    can(PERMISSIONS.DOCTOR_PROFILE_MANAGE),
    async (req, res) => {
      res.json({ data: await doctorService.verificationHistory(req.principal) });
    },
  );
  router.get('/doctors/me/clinics', can(PERMISSIONS.DOCTOR_PROFILE_MANAGE), async (req, res) => {
    res.json({ data: await clinicService.myMemberships(req.principal) });
  });

  // ── Directory (verified, active doctors only) ───────────────────
  router.get(
    '/doctors',
    can(PERMISSIONS.DOCTORS_READ),
    validate({ query: directoryQuery }),
    async (req, res) => {
      const page = await doctorService.directory(req.valid.query);
      res.json({ data: page.items, meta: { nextCursor: page.nextCursor } });
    },
  );
  router.get(
    '/doctors/:doctorId',
    can(PERMISSIONS.DOCTORS_READ),
    validate({ params: idParam('doctorId') }),
    async (req, res) => {
      res.json({ data: await doctorService.publicProfile(req.valid.params.doctorId) });
    },
  );

  // ── Verification administration ─────────────────────────────────
  const admin = can(PERMISSIONS.ADMIN_DOCTORS);
  router.get(
    '/admin/doctor-verifications',
    admin,
    validate({ query: queueQuery }),
    async (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.json({ data: await doctorService.verificationQueue(req.valid.query) });
    },
  );
  router.get(
    '/admin/doctor-verifications/:caseId',
    admin,
    validate({ params: idParam('caseId') }),
    async (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.json({ data: await doctorService.getCase(req.valid.params.caseId, req) });
    },
  );
  router.post(
    '/admin/doctor-verifications/:caseId/start-review',
    admin,
    validate({ params: idParam('caseId') }),
    async (req, res) => {
      res.json({
        data: await doctorService.startReview(req.principal, req.valid.params.caseId, req),
      });
    },
  );
  router.post(
    '/admin/doctor-verifications/:caseId/decision',
    admin,
    validate({ params: idParam('caseId'), body: verificationDecisionSchema }),
    async (req, res) => {
      res.json({
        data: await doctorService.decide(
          req.principal,
          req.valid.params.caseId,
          req.valid.body,
          req,
        ),
      });
    },
  );
  router.post(
    '/admin/doctors/:doctorId/suspend',
    admin,
    validate({ params: idParam('doctorId'), body: suspendBody }),
    async (req, res) => {
      res.json({
        data: await doctorService.suspend(
          req.principal,
          req.valid.params.doctorId,
          req.valid.body,
          req,
        ),
      });
    },
  );

  return router;
}
