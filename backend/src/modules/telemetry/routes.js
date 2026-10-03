import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../core/http/validate.js';
import { rateLimit } from '../../core/http/rateLimit.js';
import { domainMetrics } from '../../core/metrics/domain.js';

/** Standard error classes; anything else is reported as `Other` (bounded metric labels). */
export const CLIENT_ERROR_NAMES = Object.freeze([
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'ChunkLoadError',
  'Other',
]);

const UUID_SEGMENT = /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi;

export const clientErrorSchema = z
  .object({
    kind: z.enum(['render_error', 'unhandled_rejection', 'window_error']),
    name: z
      .string()
      .max(60)
      .transform((n) => (CLIENT_ERROR_NAMES.includes(n) ? n : 'Other')),
    // Path only, identifiers replaced; no query strings, messages or stack traces.
    path: z
      .string()
      .max(200)
      .regex(/^\/[A-Za-z0-9/_:-]*$/)
      .transform((p) => p.replace(UUID_SEGMENT, '/:id')),
    release: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,40}$/)
      .optional(),
  })
  .strict();

/**
 * Browser error reporting (M11). Error messages and stack traces can contain patient data
 * rendered on screen, so the client sends only the error class, kind and route; the
 * server counts it and logs it without content. Unauthenticated (errors happen before
 * sign-in too), rate-limited per IP, and always answers 204.
 */
export function telemetryRoutes(container) {
  const { redis, logger } = container;
  const router = Router();
  router.post(
    '/telemetry/client-errors',
    rateLimit({ redis, keyPrefix: 'client-errors', points: 20, durationSeconds: 60 }),
    validate({ body: clientErrorSchema }),
    (req, res) => {
      const { kind, name, path, release } = req.valid.body;
      domainMetrics.clientErrors.inc({ kind, name });
      logger.warn({ kind, name, path, release, requestId: req.id }, 'client error reported');
      res.status(204).end();
    },
  );
  return router;
}
