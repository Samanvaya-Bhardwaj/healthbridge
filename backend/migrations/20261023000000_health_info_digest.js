/**
 * ADR-0040: general health information is a free-text workflow, like the assistant's own
 * messages and record questions. Its runs keep only the backend's keyed digest of the
 * message (ADR-0012), never a plain SHA-256.
 */

const BEFORE = `('care_assistant', 'record_question', 'follow_up_summary')`;
const AFTER = `('care_assistant', 'record_question', 'follow_up_summary', 'health_info')`;

const constraint = (workflows) => `
  ALTER TABLE ai.ai_runs DROP CONSTRAINT ai_runs_free_text_digest_keyed;
  ALTER TABLE ai.ai_runs ADD CONSTRAINT ai_runs_free_text_digest_keyed CHECK (
    workflow NOT IN ${workflows}
    OR input_hash IS NULL
    OR input_digest_key_id IS NOT NULL);
`;

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.raw(constraint(AFTER));
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw(constraint(BEFORE));
}
