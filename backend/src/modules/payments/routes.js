import express, { Router } from 'express';
import { z } from 'zod';
import { manualRefundSchema, simulatePaymentSchema } from '@healthbridge/shared';
import { validate } from '../../core/http/validate.js';
import { BadRequestError } from '../../core/http/errors.js';
import { rateLimit } from '../../core/http/rateLimit.js';

const idParam = z.object({ id: z.string().max(64) });
/** Checkout takes no input: amount, currency and status come only from the server. */
const emptyBody = z.object({}).strict();
const IDEMPOTENCY = /^[A-Za-z0-9_-]{8,100}$/;
const WEBHOOK_BODY_LIMIT = '64kb';

const noStore = (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};

/**
 * Patient payment endpoints (authenticated). Gate 1 is clinic-aware (refunds by clinic
 * administrators), so permissions are evaluated in the service with the appointment.
 * @param {ReturnType<typeof import('../../container.js').createContainer>} container
 */
export function paymentRoutes(container) {
  const { authenticate, paymentService, config } = container;
  const router = Router();

  router.post(
    '/appointments/:id/payment',
    authenticate(),
    noStore,
    validate({ params: idParam, body: emptyBody }),
    async (req, res) => {
      res.json({ data: await paymentService.checkout(req.principal, req.valid.params.id, req) });
    },
  );
  router.get(
    '/appointments/:id/payment',
    authenticate(),
    noStore,
    validate({ params: idParam }),
    async (req, res) => {
      res.json({
        data: await paymentService.getForAppointment(req.principal, req.valid.params.id, req),
      });
    },
  );
  router.post(
    '/appointments/:id/refunds',
    authenticate(),
    validate({ params: idParam, body: manualRefundSchema }),
    async (req, res) => {
      // Refunds move money: a client-chosen key is mandatory so retries cannot duplicate.
      const key = req.get('idempotency-key');
      if (!key || !IDEMPOTENCY.test(key)) {
        throw new BadRequestError(
          'An Idempotency-Key header of 8–100 URL-safe characters is required.',
          'idempotency_key_required',
        );
      }
      const result = await paymentService.refund(
        req.principal,
        req.valid.params.id,
        req.valid.body,
        key,
        req,
      );
      res.status(result.created ? 202 : 200).json({ data: result.refund });
    },
  );

  if (config.payments.simulationEnabled) {
    // Development/test only (fake provider): see paymentService.simulate.
    router.post(
      '/appointments/:id/payment/simulate',
      authenticate(),
      validate({ params: idParam, body: simulatePaymentSchema }),
      async (req, res) => {
        res.json({
          data: await paymentService.simulate(
            req.principal,
            req.valid.params.id,
            req.valid.body,
            req,
          ),
        });
      },
    );
  }
  return router;
}

/**
 * Provider webhooks: no user authentication (the provider is the caller); authenticity
 * comes from the HMAC signature over the raw body, so the body is not JSON-parsed first.
 * Mounted before the global API rate limiter with its own, higher limit.
 */
export function paymentWebhookRouter(container) {
  const { webhookService, redis } = container;
  const router = Router();
  router.post(
    '/:provider',
    rateLimit({ redis, keyPrefix: 'payment-webhooks', points: 1200, durationSeconds: 60 }),
    express.raw({ type: () => true, limit: WEBHOOK_BODY_LIMIT }),
    async (req, res) => {
      const result = await webhookService.handle(
        String(req.params.provider).slice(0, 32),
        req.body,
        Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), String(v)]),
        ),
        req,
      );
      res.json({ data: { received: true, duplicate: result.duplicate, status: result.status } });
    },
  );
  return router;
}
