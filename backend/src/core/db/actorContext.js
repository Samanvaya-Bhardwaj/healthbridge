/**
 * Row-level security context (ADR-0017).
 *
 * Patient-scoped tables have RLS policies keyed on the transaction-local setting
 * `app.user_id`. Every query against them must run inside `withActor`, which opens a
 * transaction and sets the acting user's ID with `set_config(..., true)` (local to the
 * transaction, so it can never leak to another request through the connection pool).
 * Without it, PostgreSQL returns no rows and rejects writes.
 */

const ACTOR = Symbol('healthbridge.actorContext');
const SYSTEM = Symbol('healthbridge.systemContext');

/** System purposes recognised by the database (authz.system_purpose(), ADR-0020). */
export const SYSTEM_PURPOSES = Object.freeze([
  'payments',
  'scheduler',
  'notifications',
  'documents',
  'consents',
  'timeline',
  'prescriptions',
  'followups',
  // M13.1: retention sweep of expired care-assistant sessions.
  'assistant',
]);

/**
 * Runs `fn` in a transaction scoped to `userId`. Reuses an existing actor transaction
 * when one is passed in.
 * @template T
 * @param {import('knex').Knex} knex
 * @param {string} userId
 * @param {(trx: import('knex').Knex.Transaction) => Promise<T>} fn
 * @param {import('knex').Knex.Transaction} [existing]
 * @returns {Promise<T>}
 */
export async function withActor(knex, userId, fn, existing) {
  if (existing) {
    assertActorTransaction(existing);
    if (existing[ACTOR] !== userId) throw new Error('actor context mismatch');
    return fn(existing);
  }
  if (!userId) throw new Error('withActor requires a user id');
  return knex.transaction(async (trx) => {
    await trx.raw("SELECT set_config('app.user_id', ?, true)", [userId]);
    trx[ACTOR] = userId;
    return fn(trx);
  });
}

/**
 * Runs `fn` in a system transaction for background work that has no acting user
 * (verified webhooks, workers). Sets the transaction-local `app.system_purpose`; RLS
 * grants each purpose only the tables it needs. A system transaction never carries a
 * user id, and the database ignores the purpose whenever a user id is set.
 * @template T
 * @param {import('knex').Knex} knex
 * @param {'payments'|'scheduler'|'notifications'|'documents'|'consents'} purpose
 * @param {(trx: import('knex').Knex.Transaction) => Promise<T>} fn
 * @param {import('knex').Knex.TransactionConfig} [options]
 * @returns {Promise<T>}
 */
export async function withSystem(knex, purpose, fn, options) {
  if (!SYSTEM_PURPOSES.includes(purpose)) throw new Error(`unknown system purpose ${purpose}`);
  return knex.transaction(async (trx) => {
    await trx.raw("SELECT set_config('app.system_purpose', ?, true)", [purpose]);
    trx[SYSTEM] = purpose;
    return fn(trx);
  }, options);
}

/** Repositories for patient-scoped tables call this to refuse queries without RLS context. */
export function assertActorTransaction(trx) {
  if (!trx || !trx[ACTOR]) {
    throw new Error('patient-scoped query attempted outside an actor (RLS) transaction');
  }
}

/** For tables reachable from both user requests and system work (e.g. payments). */
export function assertScopedTransaction(trx, purpose) {
  if (trx?.[ACTOR]) return;
  if (trx?.[SYSTEM] && (!purpose || trx[SYSTEM] === purpose)) return;
  throw new Error(
    `scoped query attempted outside an actor or ${purpose ?? 'system'} (RLS) transaction`,
  );
}

/** For system-only tables (ledger, webhook events, deliveries). */
export function assertSystemTransaction(trx, purpose) {
  if (!trx?.[SYSTEM] || (purpose && trx[SYSTEM] !== purpose)) {
    throw new Error(`system query attempted outside a ${purpose ?? 'system'} transaction`);
  }
}

export const actorOf = (trx) => trx?.[ACTOR] ?? null;
export const systemPurposeOf = (trx) => trx?.[SYSTEM] ?? null;
