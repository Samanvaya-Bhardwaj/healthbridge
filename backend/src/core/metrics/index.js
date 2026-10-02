import express from 'express';
import client from 'prom-client';
import { domainRegistry } from './domain.js';

export function createMetrics({ service = 'healthbridge-api' } = {}) {
  const registry = new client.Registry();
  registry.setDefaultLabels({ service });
  client.collectDefaultMetrics({ register: registry });

  const httpDuration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });

  /** Records request latency by route template (never raw URLs, which may contain IDs). */
  const httpMiddleware = () => (req, res, next) => {
    const end = httpDuration.startTimer();
    res.on('finish', () => {
      const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched';
      end({ method: req.method, route, status_code: res.statusCode });
    });
    next();
  };

  return { registry, httpMiddleware };
}

/**
 * Separate, internal-only listener for Prometheus scraping (process metrics plus the
 * domain metrics of core/metrics/domain.js). `extraRoutes` lets the worker add liveness.
 */
export function createMetricsApp(registry, extraRoutes) {
  const merged = client.Registry.merge([registry, domainRegistry]);
  const app = express();
  app.disable('x-powered-by');
  app.get('/metrics', async (_req, res) => {
    res.type(merged.contentType).send(await merged.metrics());
  });
  extraRoutes?.(app);
  return app;
}
