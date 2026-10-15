// Step 9: audit coverage across the whole integration suite.
//
// Every successful state-changing API request (POST, PUT, PATCH, DELETE answering 2xx)
// made by any integration test must leave at least one audit row carrying its request ID.
// The harness checks this when each test file closes, so a new endpoint that forgets to
// audit fails the suite the first time a test exercises it. The exceptions are below, each
// with its reason; keep the list short.

/** Never an audit event. */
export const NOT_AUDITED = new Map([
  ['POST /telemetry/client-errors', 'a content-free browser error report, not an action'],
  [
    'POST /auth/refresh',
    'routine access-token rotation; every refused refresh, and refresh-token reuse, is audited',
  ],
  ['POST /notifications/:id/read', 'marks one of your own notifications read; no record access'],
  ['POST /notifications/read-all', 'marks your own notifications read; no record access'],
  [
    'POST /appointments/:id/waiting-room',
    'a presence heartbeat polled while the patient waits; starting and joining are audited',
  ],
]);

/** Audited when something changes; a repeat that changes nothing writes no audit row. */
export const AUDITED_WHEN_CHANGED = new Map([
  ['POST /appointments/:id/payment', 'reopening checkout for the same payment changes nothing'],
  [
    'POST /appointments/:id/refunds',
    'a retry with the same Idempotency-Key returns the first refund',
  ],
  ['POST /appointments/:id/consultation/start', 'starting a consultation that is already live'],
  ['POST /users/me/email-verification', 'nothing is sent once the address is confirmed'],
]);

/**
 * Recorded in a dedicated ledger keyed by request ID instead of the audit log. Webhook
 * deliveries are stored in `payment_events` (verified, replay-safe); invalid, duplicate and
 * rejected deliveries and every settlement they cause are audited as well.
 */
export const LEDGERS = new Map([['POST /webhooks/payments/:provider', 'payment_events']]);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const API_BASE = '/api/v1';

/** Wraps the app so each successful mutation's route template and request ID are recorded. */
export function trackMutations(app) {
  const seen = [];
  const tracked = (req, res) => {
    res.on('finish', () => {
      if (SAFE_METHODS.has(req.method) || res.statusCode < 200 || res.statusCode > 299) return;
      const path = req.route?.path;
      if (!path || !req.id) return;
      const base = (req.baseUrl ?? '').replace(API_BASE, '');
      seen.push({ route: `${req.method} ${base}${path}`, requestId: req.id });
    });
    return app(req, res);
  };
  return { tracked, seen };
}

async function recordedIds(ownerKnex, table, ids) {
  const found = new Set();
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await ownerKnex(table)
      .distinct('request_id')
      .whereIn('request_id', ids.slice(i, i + 500));
    for (const r of rows) found.add(r.request_id);
  }
  return found;
}

/** The recorded mutations that left no record and are not exempt, one entry per route. */
export async function unauditedMutations(ownerKnex, seen) {
  const checked = seen.filter(
    (m) => !NOT_AUDITED.has(m.route) && !AUDITED_WHEN_CHANGED.has(m.route),
  );
  if (checked.length === 0) return [];
  const ids = checked.map((m) => m.requestId);
  const recorded = await recordedIds(ownerKnex, 'audit.audit_logs', ids);
  for (const table of new Set(LEDGERS.values())) {
    for (const id of await recordedIds(ownerKnex, table, ids)) recorded.add(id);
  }
  const missing = new Set();
  for (const m of checked) if (!recorded.has(m.requestId)) missing.add(m.route);
  return [...missing].sort();
}
