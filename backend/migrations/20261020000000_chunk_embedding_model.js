/**
 * Local AI (Ollama): retrieval compares vectors only within one embedding model.
 *
 * Switching providers (the offline hashing default, Ollama, Voyage) would otherwise
 * compare vectors from different spaces. Each chunk now records the model that embedded
 * it; existing chunks came from the hashing default. Lexical ranking covers chunks of
 * any model, so older documents stay findable after a switch.
 */

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE ai.document_chunks
      ADD COLUMN embedding_model text NOT NULL DEFAULT 'hashing'
        CHECK (char_length(embedding_model) BETWEEN 1 AND 120);
    CREATE INDEX chunks_model_idx ON ai.document_chunks (embedding_model);
  `);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw(`
    DROP INDEX IF EXISTS ai.chunks_model_idx;
    ALTER TABLE ai.document_chunks DROP COLUMN IF EXISTS embedding_model;
  `);
}
