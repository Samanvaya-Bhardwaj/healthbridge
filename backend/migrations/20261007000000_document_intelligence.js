/**
 * M6: document intelligence (ADR-0022, refining ADR-0004/0010/0012).
 *
 * `ai` schema (written by the AI service role, never authoritative):
 *   ai_runs              one row per AI execution: provider, model, tokens, cost, status,
 *                        validation status, prompt version and input hash (no raw prompts)
 *   ai_sources           sources an AI run used
 *   document_extractions versioned, grounded extraction proposals per document
 *   document_chunks      patient-scoped text chunks + embeddings for retrieval (M8)
 * RLS per role: the AI role sees only the patient in its verified scope
 * (`ai.patient_id`, set from a backend-signed scope token); the application role reads
 * extractions under the M5 consent model and never reads chunks.
 *
 * Core tables (written only by backend workflows):
 *   document_metadata  versioned, validated classification metadata (non-clinical)
 *   lab_results        values a consented treating doctor verified (human promotion)
 *   patients.ai_document_processing  explicit per-patient opt-in
 */

const NEW_PERMISSIONS = [['lab_results:verify', 'Verify AI-extracted lab values into the record']];
const NEW_ROLE_PERMISSIONS = { DOCTOR: ['lab_results:verify'] };

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  const app = process.env.DB_APP_USER ?? 'hb_app';
  const ai = process.env.DB_AI_USER ?? 'hb_ai';
  for (const role of [app, ai]) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) throw new Error(`Invalid role name: ${role}`);
  }

  await knex('permissions').insert(
    NEW_PERMISSIONS.map(([code, description]) => ({ code, description })),
  );
  const roleIds = Object.fromEntries(
    (await knex('roles').select('id', 'code')).map((r) => [r.code, r.id]),
  );
  const permIds = Object.fromEntries(
    (await knex('permissions').select('id', 'code')).map((p) => [p.code, p.id]),
  );
  await knex('role_permissions').insert(
    Object.entries(NEW_ROLE_PERMISSIONS).flatMap(([role, perms]) =>
      perms.map((perm) => ({ role_id: roleIds[role], permission_id: permIds[perm] })),
    ),
  );

  await knex.raw(`
    -- pgvector moves to a dedicated schema so the AI role can use vector types and
    -- operators without any access to the core public schema (M0 invariant).
    CREATE SCHEMA IF NOT EXISTS extensions;
    REVOKE ALL ON SCHEMA extensions FROM PUBLIC;
    ALTER EXTENSION vector SET SCHEMA extensions;
    GRANT USAGE ON SCHEMA extensions TO "${ai}", "${app}";
    -- Unqualified vector types/operators keep resolving for every role.
    DO $do$ BEGIN
      EXECUTE format('ALTER DATABASE %I SET search_path = "$user", public, extensions', current_database());
    END $do$;

    -- Patient scope of the AI service's current transaction (from a verified scope token).
    CREATE FUNCTION ai.scope_patient_id() RETURNS uuid
      LANGUAGE sql STABLE SET search_path = pg_catalog AS $fn$
      SELECT CASE
        WHEN current_setting('ai.patient_id', true) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN current_setting('ai.patient_id', true)::uuid
      END
    $fn$;
    REVOKE ALL ON FUNCTION ai.scope_patient_id() FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION ai.scope_patient_id() TO "${ai}", "${app}";

    CREATE TABLE ai.ai_runs (
      id uuid PRIMARY KEY,
      workflow text NOT NULL CHECK (workflow ~ '^[a-z_]{1,64}$'),
      agent text CHECK (agent IS NULL OR agent ~ '^[a-z_]{1,64}$'),
      patient_id uuid,
      provider text,
      requested_model text,
      model text,
      status text NOT NULL CHECK (status IN ('running', 'ok', 'refused', 'error')),
      error_kind text,
      output_validation_status text CHECK (output_validation_status IS NULL OR output_validation_status IN
        ('schema_valid', 'grounded', 'partially_grounded', 'citations_valid', 'insufficient_evidence', 'rejected')),
      prompt_version text,
      input_hash text CHECK (input_hash IS NULL OR input_hash ~ '^[0-9a-f]{64}$'),
      llm_calls integer NOT NULL DEFAULT 0,
      input_tokens integer NOT NULL DEFAULT 0,
      output_tokens integer NOT NULL DEFAULT 0,
      cache_read_input_tokens integer NOT NULL DEFAULT 0,
      cache_creation_input_tokens integer NOT NULL DEFAULT 0,
      estimated_cost_usd numeric(12, 6),
      latency_ms integer,
      injection_flags text[] NOT NULL DEFAULT '{}',
      request_id text,
      started_at timestamptz NOT NULL DEFAULT now(),
      ended_at timestamptz
    );
    CREATE INDEX ai_runs_started_idx ON ai.ai_runs (started_at DESC);
    CREATE INDEX ai_runs_patient_idx ON ai.ai_runs (patient_id, started_at DESC);

    CREATE TABLE ai.ai_sources (
      id uuid PRIMARY KEY,
      run_id uuid NOT NULL REFERENCES ai.ai_runs (id) ON DELETE RESTRICT,
      patient_id uuid NOT NULL,
      source_type text NOT NULL CHECK (source_type IN ('medical_document', 'document_chunk', 'lab_result', 'medical_event')),
      source_id uuid NOT NULL,
      UNIQUE (run_id, source_type, source_id)
    );

    CREATE TABLE ai.document_extractions (
      id uuid PRIMARY KEY,
      patient_id uuid NOT NULL,
      document_id uuid NOT NULL,
      document_type text NOT NULL,
      version integer NOT NULL CHECK (version >= 1),
      run_id uuid NOT NULL REFERENCES ai.ai_runs (id) ON DELETE RESTRICT,
      input_sha256 text NOT NULL CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
      prompt_version text NOT NULL,
      status text NOT NULL CHECK (status IN ('completed', 'needs_clinician_review', 'no_text', 'failed')),
      text_source text NOT NULL CHECK (text_source IN ('pdf_text', 'ocr', 'none')),
      classification jsonb NOT NULL DEFAULT '{}',
      fields jsonb NOT NULL DEFAULT '[]',
      dropped_field_count integer NOT NULL DEFAULT 0,
      injection_flags text[] NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (document_id, version),
      CHECK (pg_column_size(fields) <= 262144)
    );
    CREATE INDEX extractions_patient_idx ON ai.document_extractions (patient_id, created_at DESC);

    CREATE TABLE ai.document_chunks (
      id uuid PRIMARY KEY,
      patient_id uuid NOT NULL,
      document_id uuid NOT NULL,
      document_type text NOT NULL,
      extraction_id uuid NOT NULL REFERENCES ai.document_extractions (id) ON DELETE RESTRICT,
      chunk_index integer NOT NULL,
      content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 4000),
      embedding extensions.vector(1024) NOT NULL,
      tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (extraction_id, chunk_index)
    );
    CREATE INDEX chunks_patient_idx ON ai.document_chunks (patient_id, document_id);
    CREATE INDEX chunks_tsv_idx ON ai.document_chunks USING gin (tsv);
    CREATE INDEX chunks_embedding_idx ON ai.document_chunks USING hnsw (embedding extensions.vector_cosine_ops);

    -- No deletion of AI history by either runtime role.
    REVOKE DELETE, TRUNCATE ON ai.ai_runs, ai.ai_sources, ai.document_extractions, ai.document_chunks
      FROM "${ai}", "${app}";
    -- The application never writes AI artifacts.
    REVOKE INSERT, UPDATE ON ai.ai_runs, ai.ai_sources, ai.document_extractions, ai.document_chunks
      FROM "${app}";
    -- AI output is append-only: extractions and chunks are never updated (new versions).
    REVOKE UPDATE ON ai.ai_sources, ai.document_extractions, ai.document_chunks FROM "${ai}";

    ALTER TABLE ai.ai_runs ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ai.ai_sources ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ai.document_extractions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ai.document_chunks ENABLE ROW LEVEL SECURITY;

    -- AI role: only the patient in the verified scope of the current transaction.
    CREATE POLICY ai_runs_scope ON ai.ai_runs FOR ALL TO "${ai}"
      USING (patient_id IS NULL OR patient_id = ai.scope_patient_id())
      WITH CHECK (patient_id IS NULL OR patient_id = ai.scope_patient_id());
    CREATE POLICY ai_sources_scope ON ai.ai_sources FOR ALL TO "${ai}"
      USING (patient_id = ai.scope_patient_id()) WITH CHECK (patient_id = ai.scope_patient_id());
    CREATE POLICY extractions_scope ON ai.document_extractions FOR ALL TO "${ai}"
      USING (patient_id = ai.scope_patient_id()) WITH CHECK (patient_id = ai.scope_patient_id());
    CREATE POLICY chunks_scope ON ai.document_chunks FOR ALL TO "${ai}"
      USING (patient_id = ai.scope_patient_id()) WITH CHECK (patient_id = ai.scope_patient_id());

    -- Application role: extraction proposals under the M5 consent model; never chunks or
    -- runs (operations read runs through the documents system purpose).
    CREATE POLICY extractions_app_select ON ai.document_extractions FOR SELECT TO "${app}" USING (
      authz.is_patient_side(patient_id)
      OR authz.has_consent(patient_id, 'medical_documents', document_type)
      OR authz.system_purpose() = 'documents');
    CREATE POLICY ai_runs_app_select ON ai.ai_runs FOR SELECT TO "${app}"
      USING (authz.system_purpose() = 'documents');
  `);

  // ── Core: validated metadata, verified lab values, opt-in ──────
  await knex.raw(`
    ALTER TABLE patients
      ADD COLUMN ai_document_processing boolean NOT NULL DEFAULT false,
      ADD COLUMN ai_processing_changed_at timestamptz;

    -- The document worker (documents system purpose) may learn only whether a patient
    -- opted in to AI processing — nothing else from the patient row.
    CREATE FUNCTION authz.ai_processing_enabled(p_patient uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
      SELECT coalesce((SELECT p.ai_document_processing FROM patients p
                        WHERE p.id = p_patient AND p.deleted_at IS NULL), false)
         AND authz.system_purpose() = 'documents'
    $fn$;
    REVOKE ALL ON FUNCTION authz.ai_processing_enabled(uuid) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION authz.ai_processing_enabled(uuid) TO "${app}";

    CREATE TABLE document_metadata (
      id uuid PRIMARY KEY,
      document_id uuid NOT NULL REFERENCES medical_documents (id) ON DELETE RESTRICT,
      patient_id uuid NOT NULL REFERENCES patients (id) ON DELETE RESTRICT,
      document_type text NOT NULL,
      version integer NOT NULL CHECK (version >= 1),
      extraction_id uuid NOT NULL REFERENCES ai.document_extractions (id) ON DELETE RESTRICT,
      detected_type text CHECK (detected_type IS NULL OR detected_type IN
        ('lab_report', 'prescription', 'imaging', 'discharge_summary', 'other')),
      detected_confidence numeric(4, 3) CHECK (detected_confidence IS NULL OR detected_confidence BETWEEN 0 AND 1),
      document_date date,
      issuer text CHECK (issuer IS NULL OR char_length(issuer) <= 160),
      extraction_status text NOT NULL,
      proposed_field_count integer NOT NULL DEFAULT 0,
      is_current boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (document_id, version),
      UNIQUE (extraction_id)
    );
    CREATE UNIQUE INDEX document_metadata_current ON document_metadata (document_id) WHERE is_current;

    CREATE TABLE lab_results (
      id uuid PRIMARY KEY,
      patient_id uuid NOT NULL REFERENCES patients (id) ON DELETE RESTRICT,
      document_id uuid NOT NULL REFERENCES medical_documents (id) ON DELETE RESTRICT,
      document_type text NOT NULL,
      extraction_id uuid NOT NULL REFERENCES ai.document_extractions (id) ON DELETE RESTRICT,
      field_key text NOT NULL CHECK (field_key ~ '^[a-z0-9_-]{1,64}$'),
      analyte text NOT NULL CHECK (char_length(analyte) BETWEEN 1 AND 120),
      value_numeric numeric,
      value_text text NOT NULL CHECK (char_length(value_text) BETWEEN 1 AND 60),
      unit text CHECK (unit IS NULL OR char_length(unit) <= 30),
      reference_range text CHECK (reference_range IS NULL OR char_length(reference_range) <= 60),
      flag text CHECK (flag IS NULL OR flag IN ('low', 'normal', 'high')),
      observed_on date,
      source_quote text NOT NULL CHECK (char_length(source_quote) BETWEEN 1 AND 500),
      verified_by_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
      verified_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (extraction_id, field_key)
    );
    CREATE INDEX lab_results_patient_idx ON lab_results (patient_id, observed_on DESC NULLS LAST);

    -- Verified values are immutable (corrections come with clinical versioning, ADR-0009).
    CREATE FUNCTION public.reject_lab_result_update() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      RAISE EXCEPTION 'lab_results are immutable' USING ERRCODE = 'insufficient_privilege';
    END
    $fn$;
    CREATE TRIGGER lab_results_immutable BEFORE UPDATE OR DELETE ON lab_results
      FOR EACH ROW EXECUTE FUNCTION public.reject_lab_result_update();

    ALTER TABLE document_metadata ENABLE ROW LEVEL SECURITY;
    CREATE POLICY metadata_select ON document_metadata FOR SELECT USING (
      authz.is_patient_side(patient_id)
      OR authz.has_consent(patient_id, 'medical_documents', document_type)
      OR authz.system_purpose() = 'documents');
    CREATE POLICY metadata_system_insert ON document_metadata FOR INSERT
      WITH CHECK (authz.system_purpose() = 'documents');
    CREATE POLICY metadata_system_update ON document_metadata FOR UPDATE
      USING (authz.system_purpose() = 'documents') WITH CHECK (authz.system_purpose() = 'documents');

    ALTER TABLE lab_results ENABLE ROW LEVEL SECURITY;
    CREATE POLICY lab_results_select ON lab_results FOR SELECT USING (
      authz.is_patient_side(patient_id)
      OR authz.has_consent(patient_id, 'medical_documents', document_type));
    -- Human promotion: only a consented treating doctor, as themself.
    CREATE POLICY lab_results_insert ON lab_results FOR INSERT WITH CHECK (
      verified_by_user_id = authz.current_user_id()
      AND authz.has_consent(patient_id, 'medical_documents', document_type));

    REVOKE UPDATE, DELETE, TRUNCATE ON lab_results FROM "${app}";
    REVOKE DELETE, TRUNCATE ON document_metadata FROM "${app}";

    COMMENT ON TABLE lab_results IS 'Lab values verified by a consented treating doctor from grounded AI proposals (ADR-0004, ADR-0022).';
  `);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw(`
    DROP TABLE IF EXISTS lab_results;
    DROP FUNCTION IF EXISTS public.reject_lab_result_update();
    DROP TABLE IF EXISTS document_metadata;
    DROP FUNCTION IF EXISTS authz.ai_processing_enabled(uuid);
    ALTER TABLE patients DROP COLUMN IF EXISTS ai_document_processing, DROP COLUMN IF EXISTS ai_processing_changed_at;
    DROP TABLE IF EXISTS ai.document_chunks;
    DROP TABLE IF EXISTS ai.document_extractions;
    DROP TABLE IF EXISTS ai.ai_sources;
    DROP TABLE IF EXISTS ai.ai_runs;
    DROP FUNCTION IF EXISTS ai.scope_patient_id();
    ALTER EXTENSION vector SET SCHEMA public;
    DO $do$ BEGIN
      EXECUTE format('ALTER DATABASE %I RESET search_path', current_database());
    END $do$;
    DROP SCHEMA IF EXISTS extensions;
  `);
  const codes = NEW_PERMISSIONS.map(([code]) => code);
  await knex('role_permissions')
    .whereIn('permission_id', knex('permissions').select('id').whereIn('code', codes))
    .del();
  await knex('permissions').whereIn('code', codes).del();
}
