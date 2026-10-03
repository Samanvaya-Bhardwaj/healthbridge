import crypto from 'node:crypto';
import express from 'express';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { ALL_QUEUES } from './queues.js';

const digest = (value) => crypto.createHash('sha256').update(String(value)).digest();

/** Constant-time comparison of HTTP Basic credentials (hashes have equal length). */
export function basicAuthMatches(header, { username, password }) {
  if (typeof header !== 'string' || !header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  if (sep < 0) return false;
  const userOk = crypto.timingSafeEqual(digest(decoded.slice(0, sep)), digest(username));
  const passOk = crypto.timingSafeEqual(digest(decoded.slice(sep + 1)), digest(password));
  return userOk && passOk;
}

/**
 * Bull Board (M11, ADR-0027): an operator view of the BullMQ queues, served by the worker
 * on an internal port that is never routed through Nginx.
 *   - read-only: retries go through the audited admin API (/admin/operations)
 *   - HTTP Basic credentials from the environment; disabled without a password
 *   - job data is identifiers only by construction (no patient content in queues)
 */
export function createBullBoardApp({ queues, username, password, logger }) {
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath('/');
  createBullBoard({
    queues: ALL_QUEUES.map((name) => new BullMQAdapter(queues[name], { readOnlyMode: true })),
    serverAdapter,
    options: { uiConfig: { boardTitle: 'HealthBridge queues' } },
  });

  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'no-referrer');
    if (basicAuthMatches(req.headers.authorization, { username, password })) return next();
    // Never log the supplied credentials.
    logger?.warn({ ip: req.ip, path: req.path }, 'bull board authentication failed');
    res.set('WWW-Authenticate', 'Basic realm="HealthBridge operations", charset="UTF-8"');
    return res.status(401).send('Authentication required.');
  });
  app.use('/', serverAdapter.getRouter());
  return app;
}
