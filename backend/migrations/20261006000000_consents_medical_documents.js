/**
 * M5: explicit consent and medical documents (ADR-0021).
 *
 * - `consents`: who (grantee doctor) may access which parts (scopes, document types) of a
 *   patient's record, why (purpose), for how long (expires_at, always set), granted by the
 *   patient or a managing guardian; manual (ongoing) or tied to one appointment.
 *   Evaluated at request time (authz.has_consent); never cached.
 * - `medical_documents`: metadata only (objects live in S3/MinIO). Object keys are
 *   server-generated and bound to patient and document by CHECK constraints. Status
 *   transitions are validated by a trigger; identity columns are immutable.
 * - Users may INSERT (consent grant, upload intent) but never UPDATE: revocation,
 *   expiry, upload completion, scanning, promotion and retirement run in backend-
 *   controlled system transactions (`consents`, `documents` purposes).
 */

const NEW_PERMISSIONS = [
  ['consents:manage', 'Grant and revoke access to own or managed dependents’ records'],
  ['consents:read', 'List consents given (patient side) or received (doctor)'],
  ['access_log:read', 'See who accessed own or managed dependents’ records'],
];
const NEW_ROLE_PERMISSIONS = {
  PATIENT: ['consents:manage', 'consents:read', 'access_log:read'],
  DOCTOR: ['consents:read'],
};

const M4_PURPOSES = `('payments', 'scheduler', 'notifications')`;
const M5_PURPOSES = `('payments', 'scheduler', 'notifications', 'documents', 'consents')`;

const M4_TEMPLATES = `('appointment_booked', 'payment_required', 'payment_confirmed', 'payment_failed',
  'appointment_cancelled', 'appointment_rescheduled', 'appointment_expired',
  'appointment_reminder', 'payment_refunded')`;
const M5_TEMPLATES = `('appointment_booked', 'payment_required', 'payment_confirmed', 'payment_failed',
  'appointment_cancelled', 'appointment_rescheduled', 'appointment_expired',
  'appointment_reminder', 'payment_refunded', 'document_available', 'document_rejected')`;

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

  // ── Consents ────────────────────────────────────────────────────
  await knex.schema.createTable('consents', (t) => {
    t.uuid('id').primary();
    t.uuid('patient_id').notNullable().references('id').inTable('patients').onDelete('RESTRICT');
    t.uuid('grantee_user_id').notNullable().references('id').inTable('users').onDelete('RESTRICT');
    t.uuid('grantee_doctor_id')
      .notNullable()
      .references('id')
      .inTable('doctors')
      .onDelete('RESTRICT');
    t.uuid('granted_by_user_id')
      .notNullable()
      .references('id')
      .inTable('users')
      .onDelete('RESTRICT');
    t.text('granted_by_relationship').notNullable();
    t.text('kind').notNullable();
    t.uuid('appointment_id').references('id').inTable('appointments').onDelete('RESTRICT');
    t.specificType('scopes', 'text[]').notNullable();
    t.specificType('document_types', 'text[]');
    t.text('purpose').notNullable();
    t.text('status').notNullable().defaultTo('active');
    t.timestamp('granted_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('revoked_at', { useTz: true });
    t.uuid('revoked_by_user_id').references('id').inTable('users').onDelete('RESTRICT');
    t.text('revoke_reason');
    t.timestamp('expired_at', { useTz: true });
    t.timestamps(true, true);
  });
  await knex.raw(`
    ALTER TABLE consents
      ADD CONSTRAINT consents_granted_by_valid CHECK (granted_by_relationship IN ('patient_self', 'guardian')),
      ADD CONSTRAINT consents_kind_valid CHECK (kind IN ('manual', 'appointment')),
      ADD CONSTRAINT consents_appointment_consistent CHECK ((kind = 'appointment') = (appointment_id IS NOT NULL)),
      ADD CONSTRAINT consents_scopes_valid CHECK (
        cardinality(scopes) >= 1
        AND scopes <@ ARRAY['patient_profile', 'medical_documents', 'medical_documents_upload']::text[]),
      ADD CONSTRAINT consents_document_types_valid CHECK (document_types IS NULL OR (
        cardinality(document_types) >= 1
        AND document_types <@ ARRAY['lab_report', 'prescription', 'imaging', 'discharge_summary', 'other']::text[])),
      ADD CONSTRAINT consents_purpose_valid CHECK (purpose IN ('consultation', 'ongoing_care', 'second_opinion', 'follow_up')),
      ADD CONSTRAINT consents_status_valid CHECK (status IN ('active', 'revoked', 'expired')),
      ADD CONSTRAINT consents_expiry_valid CHECK (expires_at > granted_at AND expires_at <= granted_at + interval '400 days'),
      ADD CONSTRAINT consents_revoked_consistent CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
      ADD CONSTRAINT consents_expired_consistent CHECK ((status = 'expired') = (expired_at IS NOT NULL)),
      ADD CONSTRAINT consents_revoke_reason_valid CHECK (revoke_reason IS NULL OR revoke_reason IN
        ('no_longer_needed', 'changed_doctor', 'privacy', 'other', 'appointment_cancelled'));
    -- One active consent of each kind per patient and doctor (per appointment).
    CREATE UNIQUE INDEX consents_one_active_manual ON consents (patient_id, grantee_user_id)
      WHERE status = 'active' AND kind = 'manual';
    CREATE UNIQUE INDEX consents_one_active_appointment ON consents (patient_id, grantee_user_id, appointment_id)
      WHERE status = 'active' AND kind = 'appointment';
    CREATE INDEX consents_grantee_idx ON consents (grantee_user_id, patient_id) WHERE status = 'active';
    CREATE INDEX consents_patient_idx ON consents (patient_id, granted_at DESC);
    CREATE INDEX consents_expiry_idx ON consents (expires_at) WHERE status = 'active';
  `);

  // ── Medical documents ───────────────────────────────────────────
  await knex.schema.createTable('medical_documents', (t) => {
    t.uuid('id').primary();
    t.uuid('patient_id').notNullable().references('id').inTable('patients').onDelete('RESTRICT');
    t.uuid('uploaded_by_user_id')
      .notNullable()
      .references('id')
      .inTable('users')
      .onDelete('RESTRICT');
    t.text('uploaded_by_relationship').notNullable();
    t.uuid('uploader_consent_id').references('id').inTable('consents').onDelete('RESTRICT');
    t.text('document_type').notNullable();
    t.text('title').notNullable();
    t.text('original_filename').notNullable();
    t.text('declared_content_type').notNullable();
    t.text('detected_content_type');
    t.integer('declared_size_bytes').notNullable();
    t.bigInteger('object_size_bytes');
    t.text('declared_sha256').notNullable();
    t.text('verified_sha256');
    t.text('quarantine_key').notNullable().unique();
    t.text('storage_key').notNullable().unique();
    t.text('status').notNullable().defaultTo('pending_upload');
    t.text('rejection_reason');
    t.text('scanner');
    t.integer('scan_attempts').notNullable().defaultTo(0);
    t.timestamp('upload_expires_at', { useTz: true }).notNullable();
    t.timestamp('uploaded_at', { useTz: true });
    t.timestamp('scanned_at', { useTz: true });
    t.timestamp('available_at', { useTz: true });
    t.timestamp('rejected_at', { useTz: true });
    t.timestamp('retired_at', { useTz: true });
    t.uuid('retired_by_user_id').references('id').inTable('users').onDelete('RESTRICT');
    t.timestamps(true, true);
  });
  await knex.raw(`
    ALTER TABLE medical_documents
      ADD CONSTRAINT documents_uploader_valid CHECK (uploaded_by_relationship IN ('patient_self', 'guardian', 'treating_doctor')),
      ADD CONSTRAINT documents_doctor_upload_consent CHECK ((uploaded_by_relationship = 'treating_doctor') = (uploader_consent_id IS NOT NULL)),
      ADD CONSTRAINT documents_type_valid CHECK (document_type IN ('lab_report', 'prescription', 'imaging', 'discharge_summary', 'other')),
      ADD CONSTRAINT documents_title_valid CHECK (char_length(title) BETWEEN 1 AND 120 AND title !~ '[[:cntrl:]/\\\\]'),
      ADD CONSTRAINT documents_filename_valid CHECK (char_length(original_filename) BETWEEN 1 AND 200 AND original_filename !~ '[[:cntrl:]/\\\\]'),
      ADD CONSTRAINT documents_declared_type_valid CHECK (declared_content_type IN ('application/pdf', 'image/png', 'image/jpeg')),
      ADD CONSTRAINT documents_detected_type_valid CHECK (detected_content_type IS NULL OR detected_content_type IN ('application/pdf', 'image/png', 'image/jpeg')),
      ADD CONSTRAINT documents_size_valid CHECK (declared_size_bytes BETWEEN 1 AND 26214400),
      ADD CONSTRAINT documents_sha_format CHECK (declared_sha256 ~ '^[0-9a-f]{64}$' AND (verified_sha256 IS NULL OR verified_sha256 ~ '^[0-9a-f]{64}$')),
      -- Object keys are server-generated, random, and bound to this patient and document:
      -- no user-supplied path segment can ever reach the key.
      ADD CONSTRAINT documents_quarantine_key_format CHECK (
        quarantine_key = 'quarantine/patients/' || patient_id::text || '/documents/' || id::text || '/' || substring(quarantine_key from '[0-9a-f]{32}$')),
      ADD CONSTRAINT documents_storage_key_format CHECK (
        storage_key = 'records/patients/' || patient_id::text || '/documents/' || id::text || '/' || substring(storage_key from '[0-9a-f]{32}$')),
      ADD CONSTRAINT documents_status_valid CHECK (status IN ('pending_upload', 'quarantined', 'scanning', 'available', 'rejected', 'retired')),
      ADD CONSTRAINT documents_rejection_consistent CHECK ((rejection_reason IS NOT NULL) = (rejected_at IS NOT NULL)),
      ADD CONSTRAINT documents_rejection_reason_valid CHECK (rejection_reason IS NULL OR rejection_reason IN (
        'infected', 'unsupported_content', 'type_mismatch', 'size_exceeded', 'size_mismatch',
        'checksum_mismatch', 'upload_missing', 'upload_expired')),
      ADD CONSTRAINT documents_available_consistent CHECK (status <> 'available' OR (
        available_at IS NOT NULL AND verified_sha256 IS NOT NULL AND detected_content_type IS NOT NULL
        AND scanner IS NOT NULL AND scanned_at IS NOT NULL)),
      ADD CONSTRAINT documents_retired_consistent CHECK ((status = 'retired') = (retired_at IS NOT NULL));
    CREATE INDEX documents_patient_idx ON medical_documents (patient_id, created_at DESC);
    CREATE INDEX documents_pending_idx ON medical_documents (upload_expires_at) WHERE status = 'pending_upload';

    -- Defence in depth: identity columns never change, and only lifecycle transitions
    -- are possible, whoever the caller is.
    CREATE FUNCTION public.guard_medical_document_update() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF NEW.id <> OLD.id OR NEW.patient_id <> OLD.patient_id
         OR NEW.uploaded_by_user_id <> OLD.uploaded_by_user_id
         OR NEW.uploaded_by_relationship <> OLD.uploaded_by_relationship
         OR NEW.uploader_consent_id IS DISTINCT FROM OLD.uploader_consent_id
         OR NEW.quarantine_key <> OLD.quarantine_key OR NEW.storage_key <> OLD.storage_key
         OR NEW.declared_sha256 <> OLD.declared_sha256
         OR NEW.declared_size_bytes <> OLD.declared_size_bytes
         OR NEW.declared_content_type <> OLD.declared_content_type
         OR NEW.document_type <> OLD.document_type
         OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'immutable medical document column changed' USING ERRCODE = 'insufficient_privilege';
      END IF;
      IF NEW.status <> OLD.status AND NOT (
           (OLD.status = 'pending_upload' AND NEW.status IN ('quarantined', 'rejected'))
        OR (OLD.status = 'quarantined' AND NEW.status IN ('scanning', 'rejected'))
        OR (OLD.status = 'scanning' AND NEW.status IN ('available', 'rejected', 'quarantined'))
        OR (OLD.status IN ('available', 'rejected') AND NEW.status = 'retired')) THEN
        RAISE EXCEPTION 'invalid medical document transition % -> %', OLD.status, NEW.status
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END
    $fn$;
    CREATE TRIGGER medical_documents_guard BEFORE UPDATE ON medical_documents
      FOR EACH ROW EXECUTE FUNCTION public.guard_medical_document_update();
  `);
  for (const table of ['consents', 'medical_documents']) {
    await knex.raw(
      `CREATE TRIGGER ${table}_set_updated_at BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()`,
    );
  }

  // ── Notification templates and system purposes ──────────────────
  await knex.raw(`
    ALTER TABLE notification_deliveries DROP CONSTRAINT deliveries_template_valid;
    ALTER TABLE notification_deliveries ADD CONSTRAINT deliveries_template_valid CHECK (template IN ${M5_TEMPLATES});
    ${systemPurposeFn(M5_PURPOSES)}
  `);

  // ── authz functions and RLS ─────────────────────────────────────
  await knex.raw(`
    -- The patient side of a patient's record: the patient or any active guardian.
    CREATE FUNCTION authz.is_patient_side(p_patient uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
      SELECT authz.is_patient_self(p_patient) OR authz.guardian_scope(p_patient) IS NOT NULL
    $fn$;

    -- Request-time consent check for the current user (ADR-0021): an ACTIVE, unexpired
    -- consent to this user covering the scope (and document type), whose appointment (if
    -- appointment-scoped) still stands, AND a current treating relationship.
    CREATE FUNCTION authz.has_consent(p_patient uuid, p_scope text, p_document_type text)
      RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
      SELECT authz.current_user_id() IS NOT NULL
         AND authz.is_treating_doctor(p_patient)
         AND EXISTS (
           SELECT 1 FROM consents c
            WHERE c.patient_id = p_patient
              AND c.grantee_user_id = authz.current_user_id()
              AND c.status = 'active' AND c.expires_at > now()
              AND p_scope = ANY (c.scopes)
              AND (p_document_type IS NULL OR c.document_types IS NULL OR p_document_type = ANY (c.document_types))
              AND (c.kind = 'manual' OR EXISTS (
                    SELECT 1 FROM appointments a
                     WHERE a.id = c.appointment_id
                       AND a.status NOT IN ('cancelled', 'expired', 'no_show'))))
    $fn$;

    -- Classification fields of a document (never content, title or storage keys) so the
    -- application's AccessPolicy can decide and audit a request before reading the row
    -- under RLS. Unrelated callers get the same 404 as for a non-existent document.
    CREATE FUNCTION authz.document_ref(p_document uuid)
      RETURNS TABLE (patient_id uuid, document_type text, status text, uploaded_by_user_id uuid)
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
      SELECT d.patient_id, d.document_type, d.status, d.uploaded_by_user_id
        FROM medical_documents d
       WHERE d.id = p_document AND authz.current_user_id() IS NOT NULL
    $fn$;

    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA authz FROM PUBLIC;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA authz TO "${app}";

    ALTER TABLE consents ENABLE ROW LEVEL SECURITY;
    CREATE POLICY consents_select ON consents FOR SELECT USING (
      authz.is_patient_side(patient_id)
      OR grantee_user_id = authz.current_user_id()
      OR authz.system_purpose() IN ('consents', 'documents'));
    CREATE POLICY consents_insert ON consents FOR INSERT WITH CHECK (
      granted_by_user_id = authz.current_user_id() AND status = 'active'
      AND revoked_at IS NULL AND expired_at IS NULL
      AND authz.can_manage_patient(patient_id));
    -- Revocation and expiry: backend-controlled system transactions only.
    CREATE POLICY consents_system_update ON consents FOR UPDATE
      USING (authz.system_purpose() = 'consents') WITH CHECK (authz.system_purpose() = 'consents');

    ALTER TABLE medical_documents ENABLE ROW LEVEL SECURITY;
    CREATE POLICY documents_select ON medical_documents FOR SELECT USING (
      authz.is_patient_side(patient_id)
      OR (status = 'available' AND authz.has_consent(patient_id, 'medical_documents', document_type))
      OR (uploaded_by_user_id = authz.current_user_id()
          AND authz.has_consent(patient_id, 'medical_documents_upload', document_type))
      OR authz.system_purpose() = 'documents');
    CREATE POLICY documents_insert ON medical_documents FOR INSERT WITH CHECK (
      uploaded_by_user_id = authz.current_user_id() AND status = 'pending_upload'
      AND scan_attempts = 0 AND verified_sha256 IS NULL AND detected_content_type IS NULL
      AND (authz.can_manage_patient(patient_id)
           OR authz.has_consent(patient_id, 'medical_documents_upload', document_type)));
    CREATE POLICY documents_system_update ON medical_documents FOR UPDATE
      USING (authz.system_purpose() = 'documents') WITH CHECK (authz.system_purpose() = 'documents');

    REVOKE DELETE, TRUNCATE ON consents, medical_documents FROM "${app}";

    COMMENT ON TABLE consents IS 'Explicit, scoped, expiring patient consent (ADR-0021). Evaluated per request.';
    COMMENT ON TABLE medical_documents IS 'Medical document metadata; objects in S3/MinIO behind quarantine → scan → promotion (ADR-0021).';
  `);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw(`
    DROP TABLE IF EXISTS medical_documents;
    DROP FUNCTION IF EXISTS public.guard_medical_document_update();
    DROP TABLE IF EXISTS consents;
    DROP FUNCTION IF EXISTS authz.has_consent(uuid, text, text);
    DROP FUNCTION IF EXISTS authz.document_ref(uuid);
    DROP FUNCTION IF EXISTS authz.is_patient_side(uuid);
    ${systemPurposeFn(M4_PURPOSES)}
    ALTER TABLE notification_deliveries DROP CONSTRAINT deliveries_template_valid;
    -- Delivery rows are history: rows with M5 templates keep them (NOT VALID).
    ALTER TABLE notification_deliveries ADD CONSTRAINT deliveries_template_valid
      CHECK (template IN ${M4_TEMPLATES}) NOT VALID;
  `);
  const codes = NEW_PERMISSIONS.map(([code]) => code);
  await knex('role_permissions')
    .whereIn('permission_id', knex('permissions').select('id').whereIn('code', codes))
    .del();
  await knex('permissions').whereIn('code', codes).del();
}
