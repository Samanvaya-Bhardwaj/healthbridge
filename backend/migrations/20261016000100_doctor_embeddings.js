/**
 * M13.2 (ADR-0031): vector ranking for doctor search.
 *
 * `doctor_profile_embeddings` holds one embedding per doctor of their PUBLIC profile text
 * (name, specialisations, areas of practice, bio), from the AI service's configured
 * embedding provider. `content_hash` is the SHA-256 of that text: the index refresh
 * re-embeds a doctor only when it changes. Patient data is never embedded here, and the
 * search query it is compared with is built from the controlled vocabulary.
 *
 * Similarity only re-ranks results the filters and the eligibility rule already chose; if
 * embeddings are missing or the AI service is down, search ranks without them.
 */

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE doctor_profile_embeddings (
      doctor_id uuid PRIMARY KEY REFERENCES doctors (id) ON DELETE CASCADE,
      content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
      model text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 80),
      embedding extensions.vector(1024) NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX doctor_profile_embeddings_hnsw ON doctor_profile_embeddings
      USING hnsw (embedding extensions.vector_cosine_ops);
    COMMENT ON TABLE doctor_profile_embeddings IS
      'Embeddings of public doctor-profile text for search ranking (ADR-0031). No patient data.';
  `);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS doctor_profile_embeddings');
}
