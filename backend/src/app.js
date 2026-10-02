import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { pinoHttp } from 'pino-http';
import { API_BASE_PATH } from '@healthbridge/shared';
import { requestId } from './core/http/requestId.js';
import { errorHandler, notFoundHandler } from './core/http/errorHandler.js';
import { rateLimit } from './core/http/rateLimit.js';
import { healthRoutes } from './core/health/routes.js';
import { apiV1Router } from './api/v1/index.js';
import { paymentWebhookRouter } from './modules/payments/routes.js';

const JSON_BODY_LIMIT = '100kb';

/**
 * Express application factory. All infrastructure is injected so the app can be
 * exercised in tests without real dependencies.
 *
 * @param {{
 *   config: ReturnType<typeof import('./config/index.js').loadConfig>,
 *   logger: import('pino').Logger,
 *   healthChecks: import('./core/health/checks.js').HealthCheck[],
 *   redis?: import('ioredis').Redis,
 *   metrics?: { httpMiddleware: () => import('express').RequestHandler },
 *   container: ReturnType<typeof import('./container.js').createContainer>,
 *   version?: string,
 * }} deps
 */
export function createApp({
  config,
  logger,
  healthChecks,
  redis,
  metrics,
  container,
  version = '0.0.0',
}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.http.trustProxy);

  app.use(requestId());
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.id,
      // Path only: query strings can carry search terms or identifiers.
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, path: req.url?.split('?')[0] }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
      customLogLevel: (_req, res, err) =>
        err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      autoLogging: { ignore: (req) => req.url?.startsWith('/health') ?? false },
    }),
  );
  if (metrics) app.use(metrics.httpMiddleware());

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      },
      crossOriginResourcePolicy: { policy: 'same-origin' },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );

  // Infrastructure endpoints: no CORS, no rate limiting, not exposed via Nginx.
  app.use(healthRoutes({ checks: healthChecks, version }));

  // Provider webhooks: server-to-server, raw body for signature verification, own rate
  // limit; no CORS, cookies or user authentication (ADR-0020).
  app.use(`${API_BASE_PATH}/webhooks/payments`, paymentWebhookRouter(container));

  const allowedOrigins = new Set(config.http.corsOrigins);
  app.use(
    API_BASE_PATH,
    cors({
      origin: (origin, callback) => callback(null, !origin || allowedOrigins.has(origin)),
      credentials: true,
      exposedHeaders: ['X-Request-Id', 'Retry-After', 'RateLimit-Limit', 'RateLimit-Remaining'],
      allowedHeaders: [
        'Authorization',
        'Content-Type',
        'X-CSRF-Token',
        'X-Request-Id',
        'Idempotency-Key',
      ],
      maxAge: 600,
    }),
    rateLimit({ redis, keyPrefix: 'api-global', ...container.rateLimits.global }),
    express.json({ limit: JSON_BODY_LIMIT, strict: true }),
    apiV1Router({ config, version, container }),
  );

  app.use(notFoundHandler());
  app.use(errorHandler());
  return app;
}
