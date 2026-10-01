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

/** Repositories for patient-scoped tables call this to refuse queries without RLS context. */
export function assertActorTransaction(trx) {
  if (!trx || !trx[ACTOR]) {
    throw new Error('patient-scoped query attempted outside an actor (RLS) transaction');
  }
}

export const actorOf = (trx) => trx?.[ACTOR] ?? null;
