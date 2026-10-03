/**
 * M7: medical timeline (ADR-0023).
 *
 * `medical_events` is a projection — never a source of truth — rebuilt from appointments,
 * medical documents (with validated metadata) and verified lab results by the `timeline`
 * worker (system purpose `timeline`). Every event carries provenance (who or what
 * recorded it) so patients and doctors can tell reported, verified and AI-derived
 * information apart.
 *
 * Visibility (RLS): the patient side sees all events; a doctor sees document and lab
 * events only with an active `medical_documents` consent covering the document type, and
 * appointment events only for their own appointments.
 */

const NEW_PERMISSIONS = [['records:export', 'Export own or managed dependents’ health timeline']];
const NEW_ROLE_PERMISSIONS = { PATIENT: ['records:export'] };

const M5_PURPOSES = `('payments', 'scheduler', 'notifications', 'documents', 'consents')`;
const M7_PURPOSES = `('payments', 'scheduler', 'notifications', 'documents', 'consents', 'timeline')`;
const systemPurposeFn = (purposes) => `
  CREATE OR REPLACE FUNCTION authz.system_purpose() RETURNS text
    LANGUAGE sql STABLE SET search_path = pg_catalog AS $fn$
    SELECT CASE
      WHEN authz.current_user_id() IS NULL
       AND current_setting('app.system_purpose', true) IN ${purposes}
      THEN current_setting('app.system_purpose', true)
    END
  $fn$;`;

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  const app = process.env.DB_APP_USER ?? 'hb_app';
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(app)) throw new Error(`Invalid role name: ${app}`);

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
    ${systemPurposeFn(M7_PURPOSES)}

    CREATE TABLE medical_events (
      id uuid PRIMARY KEY,
      patient_id uuid NOT NULL REFERENCES patients (id) ON DELETE RESTRICT,
      event_type text NOT NULL CHECK (event_type IN ('appointment', 'document', 'lab_result')),
      source_type text NOT NULL CHECK (source_type IN ('appointment', 'medical_document', 'lab_result')),
      source_id uuid NOT NULL,
      occurred_at timestamptz NOT NULL,
      date_precision text NOT NULL DEFAULT 'instant' CHECK (date_precision IN ('instant', 'day')),
      title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
      status text CHECK (status IS NULL OR status ~ '^[a-z_]{1,32}$'),
      provenance text NOT NULL CHECK (provenance IN
        ('patient_reported', 'guardian_reported', 'doctor_reported', 'doctor_verified', 'ai_extracted', 'system_recorded')),
      actor_label text CHECK (actor_label IS NULL OR char_length(actor_label) <= 160),
      detail jsonb NOT NULL DEFAULT '{}' CHECK (pg_column_size(detail) <= 4096),
      document_type text,
      doctor_user_id uuid,
      hidden boolean NOT NULL DEFAULT false,
      projected_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (source_type, source_id)
    );
    CREATE INDEX medical_events_timeline_idx ON medical_events (patient_id, occurred_at DESC, id DESC)
      WHERE NOT hidden;

    -- The projector reads its sources and writes the projection; nothing else.
    CREATE POLICY appointments_timeline_select ON appointments FOR SELECT
      USING (authz.system_purpose() = 'timeline');
    CREATE POLICY documents_timeline_select ON medical_documents FOR SELECT
      USING (authz.system_purpose() = 'timeline');
    CREATE POLICY metadata_timeline_select ON document_metadata FOR SELECT
      USING (authz.system_purpose() = 'timeline');
    CREATE POLICY lab_results_timeline_select ON lab_results FOR SELECT
      USING (authz.system_purpose() = 'timeline');

    ALTER TABLE medical_events ENABLE ROW LEVEL SECURITY;
    CREATE POLICY medical_events_select ON medical_events FOR SELECT USING (
      authz.is_patient_side(patient_id)
      OR (event_type IN ('document', 'lab_result')
          AND authz.has_consent(patient_id, 'medical_documents', document_type))
      OR (event_type = 'appointment' AND doctor_user_id = authz.current_user_id())
      OR authz.system_purpose() = 'timeline');
    CREATE POLICY medical_events_system_insert ON medical_events FOR INSERT
      WITH CHECK (authz.system_purpose() = 'timeline');
    CREATE POLICY medical_events_system_update ON medical_events FOR UPDATE
      USING (authz.system_purpose() = 'timeline') WITH CHECK (authz.system_purpose() = 'timeline');
    REVOKE DELETE, TRUNCATE ON medical_events FROM "${app}";

    COMMENT ON TABLE medical_events IS 'Timeline projection with provenance (ADR-0023); rebuildable from sources.';
  `);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw(`
    DROP TABLE IF EXISTS medical_events;
    DROP POLICY IF EXISTS appointments_timeline_select ON appointments;
    DROP POLICY IF EXISTS documents_timeline_select ON medical_documents;
    DROP POLICY IF EXISTS metadata_timeline_select ON document_metadata;
    DROP POLICY IF EXISTS lab_results_timeline_select ON lab_results;
    ${systemPurposeFn(M5_PURPOSES)}
  `);
  const codes = NEW_PERMISSIONS.map(([code]) => code);
  await knex('role_permissions')
    .whereIn('permission_id', knex('permissions').select('id').whereIn('code', codes))
    .del();
  await knex('permissions').whereIn('code', codes).del();
}
