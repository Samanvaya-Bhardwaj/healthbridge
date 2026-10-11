/**
 * Keyed digests for free-text AI inputs (ADR-0012, ADR-0029; M13.1 pre-merge hardening).
 *
 * `ai.ai_runs.input_hash` is telemetry: it lets two runs over the same input be recognised
 * without storing the input, and nothing reads it to make a decision. For free text it
 * used to be a plain SHA-256, which can be reversed by hashing guesses of a short message.
 * The backend now sends an HMAC-SHA256 under a dedicated backend-only key
 * (`AI_INPUT_DIGEST_KEY`) together with that key's ID.
 *
 * - `input_digest_key_id`: which key produced `input_hash` (NULL: not keyed).
 * - Legacy plain SHA-256 digests of free text (care assistant messages, record questions,
 *   follow-up check-ins) are cleared. They have no operational use and are the privacy
 *   risk this change removes. This cannot be undone (by design).
 * - A constraint stops any new unkeyed digest of free text. Workflows whose input is only
 *   identifiers or document content hashes (doctor brief, document analysis) may keep a
 *   plain SHA-256.
 */

const FREE_TEXT_WORKFLOWS = `('care_assistant', 'record_question', 'follow_up_summary')`;

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE ai.ai_runs
      ADD COLUMN input_digest_key_id text
        CONSTRAINT ai_runs_digest_key_id_format
        CHECK (input_digest_key_id IS NULL OR input_digest_key_id ~ '^[a-z0-9_-]{1,32}$');

    UPDATE ai.ai_runs SET input_hash = NULL
     WHERE workflow IN ${FREE_TEXT_WORKFLOWS} AND input_hash IS NOT NULL;

    ALTER TABLE ai.ai_runs ADD CONSTRAINT ai_runs_free_text_digest_keyed CHECK (
      workflow NOT IN ${FREE_TEXT_WORKFLOWS}
      OR input_hash IS NULL
      OR input_digest_key_id IS NOT NULL);

    COMMENT ON COLUMN ai.ai_runs.input_digest_key_id IS
      'Key ID of the backend HMAC that produced input_hash (NULL: not keyed; identifiers only).';
  `);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  // Cleared legacy digests are not restored.
  await knex.raw(`
    ALTER TABLE ai.ai_runs DROP CONSTRAINT IF EXISTS ai_runs_free_text_digest_keyed;
    ALTER TABLE ai.ai_runs DROP COLUMN IF EXISTS input_digest_key_id;
  `);
}
