import { Router } from 'express';
import { z } from 'zod';
import {
  PERMISSIONS,
  createDependentSchema,
  patientProfileSchema,
  patientProfileUpdateSchema,
} from '@healthbridge/shared';
import { validate } from '../../core/http/validate.js';

const idParam = (name) => z.object({ [name]: z.string().max(64) });

/**
 * /patients/* and /guardianships/* routes. Route-level checks are gate 1 only; the
 * service enforces relationship and consent through AccessPolicy for every patient.
 * @param {ReturnType<typeof import('../../container.js').createContainer>} container
 */
export function patientRoutes(container) {
  const { authenticate, accessPolicy, patientService } = container;
  const router = Router();
  const can = (permission) => [authenticate(), accessPolicy.requirePermission(permission)];
  const noStore = (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  };

  router.post(
    '/patients/me',
    can(PERMISSIONS.PATIENTS_WRITE),
    validate({ body: patientProfileSchema }),
    async (req, res) => {
      res
        .status(201)
        .json({ data: await patientService.createOwnProfile(req.principal, req.valid.body, req) });
    },
  );

  router.get('/patients/me', can(PERMISSIONS.PATIENTS_READ), noStore, async (req, res) => {
    res.json({ data: await patientService.getOwnProfile(req.principal, req) });
  });

  router.patch(
    '/patients/me',
    can(PERMISSIONS.PATIENTS_WRITE),
    validate({ body: patientProfileUpdateSchema }),
    async (req, res) => {
      res.json({ data: await patientService.updateOwnProfile(req.principal, req.valid.body, req) });
    },
  );

  router.get(
    '/patients/me/dependents',
    can(PERMISSIONS.DEPENDENTS_MANAGE),
    noStore,
    async (req, res) => {
      res.json({ data: await patientService.listDependents(req.principal) });
    },
  );

  router.post(
    '/patients/me/dependents',
    can(PERMISSIONS.DEPENDENTS_MANAGE),
    validate({ body: createDependentSchema }),
    async (req, res) => {
      res
        .status(201)
        .json({ data: await patientService.createDependent(req.principal, req.valid.body, req) });
    },
  );

  router.get(
    '/patients/:patientId',
    can(PERMISSIONS.PATIENTS_READ),
    noStore,
    validate({ params: idParam('patientId') }),
    async (req, res) => {
      res.json({
        data: await patientService.getProfile(req.principal, req.valid.params.patientId, req),
      });
    },
  );

  router.patch(
    '/patients/:patientId',
    can(PERMISSIONS.PATIENTS_WRITE),
    validate({ params: idParam('patientId'), body: patientProfileUpdateSchema }),
    async (req, res) => {
      res.json({
        data: await patientService.updateProfile(
          req.principal,
          req.valid.params.patientId,
          req.valid.body,
          req,
        ),
      });
    },
  );

  router.get(
    '/patients/:patientId/guardians',
    can(PERMISSIONS.PATIENTS_READ),
    noStore,
    validate({ params: idParam('patientId') }),
    async (req, res) => {
      res.json({
        data: await patientService.listGuardians(req.principal, req.valid.params.patientId, req),
      });
    },
  );

  router.post(
    '/guardianships/:guardianshipId/end',
    can(PERMISSIONS.DEPENDENTS_MANAGE),
    validate({ params: idParam('guardianshipId') }),
    async (req, res) => {
      res.json({
        data: await patientService.endGuardianship(
          req.principal,
          req.valid.params.guardianshipId,
          req,
        ),
      });
    },
  );

  return router;
}
