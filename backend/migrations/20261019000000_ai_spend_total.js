/**
 * Step 10: daily ceiling on model spend (ADR-0036).
 *
 * The AI service enforces LLM_DAILY_BUDGET_USD across all its replicas from the estimated
 * cost already recorded in `ai.ai_runs`. RLS confines the AI role to one patient's runs,
 * so it cannot sum them itself. This SECURITY DEFINER function returns a single total and
 * nothing else: no rows, patients, workflows or identifiers.
 */

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  const ai = process.env.DB_AI_USER ?? 'hb_ai';
  await knex.raw(`
    CREATE FUNCTION ai.spend_since(since timestamptz) RETURNS numeric
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $fn$
      SELECT coalesce(sum(estimated_cost_usd), 0)
        FROM ai.ai_runs
       WHERE started_at >= since
    $fn$;
    REVOKE ALL ON FUNCTION ai.spend_since(timestamptz) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION ai.spend_since(timestamptz) TO "${ai}";
    COMMENT ON FUNCTION ai.spend_since(timestamptz) IS
      'Total estimated model spend since a moment (USD), for the daily ceiling (ADR-0036).';
  `);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw('DROP FUNCTION IF EXISTS ai.spend_since(timestamptz)');
}
