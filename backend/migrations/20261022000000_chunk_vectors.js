/**
 * Part 4: vectors of another embedding model for existing chunks (ADR-0037).
 *
 * Chunks are append-only AI history: neither runtime role may update them. After a switch
 * of embedding model (e.g. the hashing default to Ollama), the AI service adds a vector of
 * the current model for each existing chunk here instead, so retrieval ranks older
 * documents by meaning again. Also append-only, patient-scoped by RLS like the chunks, and
 * tied to the chunk's own patient by a composite key. The text is never copied.
 * The application role has no access, as for chunks.
 */

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  const app = process.env.DB_APP_USER ?? 'hb_app';
  const ai = process.env.DB_AI_USER ?? 'hb_ai';
  for (const role of [app, ai]) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) throw new Error(`Invalid role name: ${role}`);
  }
  await knex.raw(`
    ALTER TABLE ai.document_chunks ADD CONSTRAINT chunks_id_patient_key UNIQUE (id, patient_id);

    CREATE TABLE ai.chunk_vectors (
      chunk_id uuid NOT NULL,
      patient_id uuid NOT NULL,
      model text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 120),
      embedding extensions.vector(1024) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (chunk_id, model),
      FOREIGN KEY (chunk_id, patient_id)
        REFERENCES ai.document_chunks (id, patient_id) ON DELETE RESTRICT
    );
    CREATE INDEX chunk_vectors_patient_idx ON ai.chunk_vectors (patient_id, model);

    -- Append-only for the AI role; nothing for the application role.
    REVOKE ALL ON ai.chunk_vectors FROM "${app}";
    REVOKE UPDATE, DELETE, TRUNCATE ON ai.chunk_vectors FROM "${ai}";
    GRANT SELECT, INSERT ON ai.chunk_vectors TO "${ai}";

    ALTER TABLE ai.chunk_vectors ENABLE ROW LEVEL SECURITY;
    CREATE POLICY chunk_vectors_scope ON ai.chunk_vectors FOR ALL TO "${ai}"
      USING (patient_id = ai.scope_patient_id()) WITH CHECK (patient_id = ai.scope_patient_id());

    COMMENT ON TABLE ai.chunk_vectors IS
      'Vectors of the current embedding model for existing chunks; append-only (ADR-0037).';
  `);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw(`
    DROP TABLE IF EXISTS ai.chunk_vectors;
    ALTER TABLE ai.document_chunks DROP CONSTRAINT IF EXISTS chunks_id_patient_key;
  `);
}
