import { Router } from 'express';
import { z } from 'zod';
import {
  PERMISSIONS,
  availabilityRuleSchema,
  bookAppointmentSchema,
  cancelAppointmentSchema,
  rescheduleAppointmentSchema,
  slotQuerySchema,
  timeOffSchema,
} from '@healthbridge/shared';
import { validate } from '../../core/http/validate.js';
import { BadRequestError } from '../../core/http/errors.js';

const idParam = (name) => z.object({ [name]: z.string().max(64) });
const rangeQuery = z
  .object({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) })
  .strict()
  .refine(
    (v) =>
      new Date(v.to) > new Date(v.from) && new Date(v.to) - new Date(v.from) <= 62 * 86_400_000,
    {
      message: 'Use a range of at most 62 days.',
      path: ['to'],
    },
  );
const IDEMPOTENCY = /^[A-Za-z0-9_-]{8,100}$/;

/**
 * Availability, slots and appointments.
 * @param {ReturnType<typeof import('../../container.js').createContainer>} container
 */
export function schedulingRoutes(container) {
  const { authenticate, accessPolicy, availabilityService, appointmentService } = container;
  const router = Router();
  const can = (permission) => [authenticate(), accessPolicy.requirePermission(permission)];
  const noStore = (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  };

  // ── Doctor availability ─────────────────────────────────────────
  router.get('/doctors/me/availability', can(PERMISSIONS.AVAILABILITY_MANAGE), async (req, res) => {
    res.json({ data: await availabilityService.listRules(req.principal) });
  });
  router.post(
    '/doctors/me/availability',
    can(PERMISSIONS.AVAILABILITY_MANAGE),
    validate({ body: availabilityRuleSchema }),
    async (req, res) => {
      res
        .status(201)
        .json({ data: await availabilityService.createRule(req.principal, req.valid.body, req) });
    },
  );
  router.delete(
    '/doctors/me/availability/:ruleId',
    can(PERMISSIONS.AVAILABILITY_MANAGE),
    validate({ params: idParam('ruleId') }),
    async (req, res) => {
      await availabilityService.archiveRule(req.principal, req.valid.params.ruleId, req);
      res.status(204).end();
    },
  );
  router.get('/doctors/me/time-off', can(PERMISSIONS.AVAILABILITY_MANAGE), async (req, res) => {
    res.json({ data: await availabilityService.listTimeOff(req.principal) });
  });
  router.post(
    '/doctors/me/time-off',
    can(PERMISSIONS.AVAILABILITY_MANAGE),
    validate({ body: timeOffSchema }),
    async (req, res) => {
      res
        .status(201)
        .json({ data: await availabilityService.addTimeOff(req.principal, req.valid.body, req) });
    },
  );
  router.delete(
    '/doctors/me/time-off/:id',
    can(PERMISSIONS.AVAILABILITY_MANAGE),
    validate({ params: idParam('id') }),
    async (req, res) => {
      await availabilityService.removeTimeOff(req.principal, req.valid.params.id, req);
      res.status(204).end();
    },
  );

  // ── Slots ───────────────────────────────────────────────────────
  router.get(
    '/doctors/:doctorId/slots',
    can(PERMISSIONS.DOCTORS_READ),
    validate({ params: idParam('doctorId'), query: slotQuerySchema }),
    async (req, res) => {
      res.json({
        data: await availabilityService.slots(
          req.principal,
          req.valid.params.doctorId,
          req.valid.query,
        ),
      });
    },
  );

  // ── Appointments ────────────────────────────────────────────────
  router.post(
    '/appointments',
    can(PERMISSIONS.APPOINTMENTS_CREATE),
    validate({ body: bookAppointmentSchema }),
    async (req, res) => {
      const key = req.get('idempotency-key');
      if (key && !IDEMPOTENCY.test(key)) {
        throw new BadRequestError(
          'Idempotency-Key must be 8–100 URL-safe characters.',
          'invalid_idempotency_key',
        );
      }
      const result = await appointmentService.book(
        req.principal,
        req.valid.body,
        { idempotencyKey: key },
        req,
      );
      if (result.replayed) res.set('Idempotent-Replayed', 'true');
      res.status(result.replayed ? 200 : 201).json({ data: result.appointment });
    },
  );

  router.get(
    '/appointments',
    can(PERMISSIONS.APPOINTMENTS_READ),
    noStore,
    validate({
      query: z
        .object({
          patientId: z.string().max(64).optional(),
          scope: z.enum(['upcoming', 'past']).default('upcoming'),
        })
        .strict(),
    }),
    async (req, res) => {
      res.json({
        data: await appointmentService.listForPatient(req.principal, req.valid.query, req),
      });
    },
  );

  router.get(
    '/doctors/me/appointments',
    can(PERMISSIONS.APPOINTMENTS_READ),
    noStore,
    validate({ query: rangeQuery }),
    async (req, res) => {
      res.json({
        data: await appointmentService.listForDoctor(req.principal, req.valid.query, req),
      });
    },
  );

  // Clinic-scoped gate 1 is evaluated in the service (appointments:read for this clinic).
  router.get(
    '/clinics/:clinicId/appointments',
    authenticate(),
    noStore,
    validate({ params: z.object({ clinicId: z.uuid() }), query: rangeQuery }),
    async (req, res) => {
      res.json({
        data: await appointmentService.listForClinic(
          req.principal,
          req.valid.params.clinicId,
          req.valid.query,
          req,
        ),
      });
    },
  );

  // Gate 1 is clinic-aware for clinic schedulers, so it is evaluated in the service.
  router.get(
    '/appointments/:id',
    authenticate(),
    noStore,
    validate({ params: idParam('id') }),
    async (req, res) => {
      res.json({ data: await appointmentService.get(req.principal, req.valid.params.id, req) });
    },
  );

  router.post(
    '/appointments/:id/cancel',
    authenticate(),
    validate({ params: idParam('id'), body: cancelAppointmentSchema }),
    async (req, res) => {
      res.json({
        data: await appointmentService.act(
          req.principal,
          req.valid.params.id,
          'cancel',
          req.valid.body,
          req,
        ),
      });
    },
  );
  router.post(
    '/appointments/:id/reschedule',
    authenticate(),
    validate({ params: idParam('id'), body: rescheduleAppointmentSchema }),
    async (req, res) => {
      res.json({
        data: await appointmentService.reschedule(
          req.principal,
          req.valid.params.id,
          req.valid.body,
          req,
        ),
      });
    },
  );
  for (const [path, action] of [
    ['check-in', 'check_in'],
    ['complete', 'complete'],
    ['no-show', 'no_show'],
  ]) {
    router.post(
      `/appointments/:id/${path}`,
      authenticate(),
      validate({ params: idParam('id') }),
      async (req, res) => {
        res.json({
          data: await appointmentService.act(req.principal, req.valid.params.id, action, {}, req),
        });
      },
    );
  }

  return router;
}
