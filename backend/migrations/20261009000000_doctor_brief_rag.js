/**
 * M8: doctor brief and patient-scoped retrieval (ADR-0024).
 *
 * `ai.doctor_briefs` holds validated, cited pre-consultation briefs written by the AI
 * service for one appointment, confined by RLS to the scoped patient (AI role) and, for
 * the application, to the appointment's doctor while their consent lasts.
 * `brief_feedback` records the doctor's rating of a brief (quality loop, no free text).
 */

const NEW_PERMISSIONS = [
  ['ai_assist:use', 'Use AI briefs and record questions for consented patients'],
];
const NEW_ROLE_PERMISSIONS = { DOCTOR: ['ai_assist:use'] };

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
    CREATE TABLE ai.doctor_briefs (
      id uuid PRIMARY KEY,
      patient_id uuid NOT NULL,
      appointment_id uuid NOT NULL,
      doctor_user_id uuid NOT NULL,
      run_id uuid NOT NULL REFERENCES ai.ai_runs (id) ON DELETE RESTRICT,
      status text NOT NULL CHECK (status IN ('ready', 'insufficient_information', 'failed')),
      sections jsonb NOT NULL DEFAULT '[]' CHECK (pg_column_size(sections) <= 65536),
      source_count integer NOT NULL DEFAULT 0,
      removed_sentence_count integer NOT NULL DEFAULT 0,
      prompt_version text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX doctor_briefs_appointment_idx ON ai.doctor_briefs (appointment_id, created_at DESC);
    REVOKE DELETE, TRUNCATE, UPDATE ON ai.doctor_briefs FROM "${ai}";
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ai.doctor_briefs FROM "${app}";

    ALTER TABLE ai.doctor_briefs ENABLE ROW LEVEL SECURITY;
    CREATE POLICY doctor_briefs_scope ON ai.doctor_briefs FOR ALL TO "${ai}"
      USING (patient_id = ai.scope_patient_id()) WITH CHECK (patient_id = ai.scope_patient_id());
    -- The appointment's doctor, only while a document consent is active.
    CREATE POLICY doctor_briefs_app_select ON ai.doctor_briefs FOR SELECT TO "${app}" USING (
      doctor_user_id = authz.current_user_id()
      AND authz.has_consent(patient_id, 'medical_documents', NULL));

    CREATE TABLE brief_feedback (
      id uuid PRIMARY KEY,
      brief_id uuid NOT NULL REFERENCES ai.doctor_briefs (id) ON DELETE RESTRICT,
      patient_id uuid NOT NULL REFERENCES patients (id) ON DELETE RESTRICT,
      doctor_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
      rating text NOT NULL CHECK (rating IN ('helpful', 'not_helpful')),
      issue text CHECK (issue IS NULL OR issue IN
        ('missing_information', 'incorrect_citation', 'not_relevant', 'too_long', 'other')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (brief_id, doctor_user_id)
    );
    CREATE TRIGGER brief_feedback_set_updated_at BEFORE UPDATE ON brief_feedback
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
    ALTER TABLE brief_feedback ENABLE ROW LEVEL SECURITY;
    CREATE POLICY brief_feedback_own ON brief_feedback FOR ALL
      USING (doctor_user_id = authz.current_user_id())
      WITH CHECK (doctor_user_id = authz.current_user_id()
                  AND authz.has_consent(patient_id, 'medical_documents', NULL));
    REVOKE DELETE, TRUNCATE ON brief_feedback FROM "${app}";
  `);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw(`
    DROP TABLE IF EXISTS brief_feedback;
    DROP TABLE IF EXISTS ai.doctor_briefs;
  `);
  const codes = NEW_PERMISSIONS.map(([code]) => code);
  await knex('role_permissions')
    .whereIn('permission_id', knex('permissions').select('id').whereIn('code', codes))
    .del();
  await knex('permissions').whereIn('code', codes).del();
}
