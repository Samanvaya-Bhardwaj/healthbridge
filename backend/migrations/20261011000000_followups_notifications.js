/**
 * M10: follow-ups, patient check-ins and the in-app notification inbox (ADR-0026).
 *
 * - `follow_ups`: created from outcome A's follow-up date (worker, system purpose
 *   `followups`) or by the treating doctor; the due sweep opens them and reminds.
 * - `follow_up_responses`: the patient side's check-in (append-only); the free-text
 *   note is envelope-encrypted by the application. Deterministic rules escalate.
 * - `ai.follow_up_summaries`: the bounded follow-up agent's cited, validated summary for
 *   the doctor (written by the AI service; never shown to the patient, never decisive).
 * - `inbox_notifications`: per-user in-app notifications (generic wording).
 */

const NEW_PERMISSIONS = [
  ['followups:manage', 'Schedule, review and close follow-ups for own patients'],
  ['followups:respond', 'Answer follow-up check-ins for self or managed dependents'],
  ['notifications:read', 'Read own in-app notifications'],
];
const NEW_ROLE_PERMISSIONS = {
  PATIENT: ['followups:respond', 'notifications:read'],
  DOCTOR: ['followups:manage', 'notifications:read'],
  CLINIC_ADMIN: ['notifications:read'],
  PLATFORM_ADMIN: ['notifications:read'],
  SUPPORT: ['notifications:read'],
};

const M9_PURPOSES = `('payments', 'scheduler', 'notifications', 'documents', 'consents', 'timeline', 'prescriptions')`;
const M10_PURPOSES = `('payments', 'scheduler', 'notifications', 'documents', 'consents', 'timeline', 'prescriptions', 'followups')`;
const systemPurposeFn = (purposes) => `
  CREATE OR REPLACE FUNCTION authz.system_purpose() RETURNS text
    LANGUAGE sql STABLE SET search_path = pg_catalog AS $fn$
    SELECT CASE
      WHEN authz.current_user_id() IS NULL
       AND current_setting('app.system_purpose', true) IN ${purposes}
      THEN current_setting('app.system_purpose', true)
    END
  $fn$;`;

const M9_TEMPLATES = `('appointment_booked', 'payment_required', 'payment_confirmed', 'payment_failed',
  'appointment_cancelled', 'appointment_rescheduled', 'appointment_expired',
  'appointment_reminder', 'payment_refunded', 'document_available', 'document_rejected',
  'prescription_available', 'in_person_visit_requested', 'emergency_guidance')`;
const M10_TEMPLATES = `('appointment_booked', 'payment_required', 'payment_confirmed', 'payment_failed',
  'appointment_cancelled', 'appointment_rescheduled', 'appointment_expired',
  'appointment_reminder', 'payment_refunded', 'document_available', 'document_rejected',
  'prescription_available', 'in_person_visit_requested', 'emergency_guidance',
  'follow_up_due', 'follow_up_attention', 'follow_up_urgent')`;

const EVENTS = {
  m9: {
    event: `('appointment', 'document', 'lab_result', 'consultation', 'prescription')`,
    source: `('appointment', 'medical_document', 'lab_result', 'consultation', 'prescription')`,
    doctorOwn: `('appointment', 'consultation', 'prescription')`,
  },
  m10: {
    event: `('appointment', 'document', 'lab_result', 'consultation', 'prescription', 'follow_up')`,
    source: `('appointment', 'medical_document', 'lab_result', 'consultation', 'prescription', 'follow_up')`,
    doctorOwn: `('appointment', 'consultation', 'prescription', 'follow_up')`,
  },
};
const eventsPolicy = (v) => `
  DROP POLICY medical_events_select ON medical_events;
  CREATE POLICY medical_events_select ON medical_events FOR SELECT USING (
    authz.is_patient_side(patient_id)
    OR (event_type IN ('document', 'lab_result', 'prescription')
        AND authz.has_consent(patient_id, 'medical_documents', document_type))
    OR (event_type IN ${v.doctorOwn} AND doctor_user_id = authz.current_user_id())
    OR authz.system_purpose() = 'timeline');
  ALTER TABLE medical_events DROP CONSTRAINT medical_events_event_type_check;
  ALTER TABLE medical_events ADD CONSTRAINT medical_events_event_type_check
    CHECK (event_type IN ${v.event});
  ALTER TABLE medical_events DROP CONSTRAINT medical_events_source_type_check;
  ALTER TABLE medical_events ADD CONSTRAINT medical_events_source_type_check
    CHECK (source_type IN ${v.source});`;

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
    ${systemPurposeFn(M10_PURPOSES)}

    -- ── Follow-ups ────────────────────────────────────────────────
    CREATE TABLE follow_ups (
      id uuid PRIMARY KEY,
      patient_id uuid NOT NULL REFERENCES patients (id) ON DELETE RESTRICT,
      doctor_id uuid NOT NULL REFERENCES doctors (id) ON DELETE RESTRICT,
      doctor_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
      consultation_id uuid UNIQUE REFERENCES consultations (id) ON DELETE RESTRICT,
      appointment_id uuid REFERENCES appointments (id) ON DELETE RESTRICT,
      origin text NOT NULL CHECK (origin IN ('consultation_outcome', 'doctor')),
      due_on date NOT NULL,
      status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'awaiting_response',
        'responded', 'needs_attention', 'urgent', 'closed', 'cancelled')),
      escalation_level text NOT NULL DEFAULT 'none' CHECK (escalation_level IN ('none', 'attention', 'urgent')),
      escalation_reasons text[] NOT NULL DEFAULT '{}',
      opened_at timestamptz,
      reminder_count smallint NOT NULL DEFAULT 0 CHECK (reminder_count BETWEEN 0 AND 10),
      last_reminded_at timestamptz,
      responded_at timestamptz,
      closed_at timestamptz,
      closed_by_user_id uuid REFERENCES users (id) ON DELETE RESTRICT,
      close_note text CHECK (close_note IS NULL OR char_length(close_note) <= 500),
      created_by_user_id uuid REFERENCES users (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT follow_ups_closed_consistent CHECK ((status IN ('closed', 'cancelled')) = (closed_at IS NOT NULL)),
      CONSTRAINT follow_ups_origin_consistent CHECK ((origin = 'consultation_outcome') = (consultation_id IS NOT NULL))
    );
    CREATE INDEX follow_ups_due_idx ON follow_ups (due_on) WHERE status IN ('scheduled', 'awaiting_response');
    CREATE INDEX follow_ups_doctor_idx ON follow_ups (doctor_user_id, status, due_on);
    CREATE INDEX follow_ups_patient_idx ON follow_ups (patient_id, due_on DESC);
    CREATE TRIGGER follow_ups_set_updated_at BEFORE UPDATE ON follow_ups
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

    -- The patient side may only record its response (status, escalation, time) on an
    -- open check-in; identity never changes; closed follow-ups are final.
    CREATE FUNCTION follow_ups_guard() RETURNS trigger
      LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
    BEGIN
      IF NEW.id <> OLD.id OR NEW.patient_id <> OLD.patient_id OR NEW.doctor_id <> OLD.doctor_id
         OR NEW.doctor_user_id <> OLD.doctor_user_id
         OR NEW.consultation_id IS DISTINCT FROM OLD.consultation_id OR NEW.origin <> OLD.origin THEN
        RAISE EXCEPTION 'follow-up identity is immutable' USING ERRCODE = 'check_violation';
      END IF;
      IF OLD.status IN ('closed', 'cancelled') THEN
        RAISE EXCEPTION 'a closed follow-up is final' USING ERRCODE = 'check_violation';
      END IF;
      IF authz.current_user_id() IS NOT NULL AND authz.current_user_id() <> OLD.doctor_user_id THEN
        IF OLD.status NOT IN ('scheduled', 'awaiting_response')
           OR NEW.status NOT IN ('responded', 'needs_attention', 'urgent')
           OR NEW.due_on <> OLD.due_on OR NEW.reminder_count <> OLD.reminder_count
           OR NEW.closed_at IS NOT NULL OR NEW.close_note IS DISTINCT FROM OLD.close_note
           OR NEW.opened_at IS DISTINCT FROM OLD.opened_at THEN
          RAISE EXCEPTION 'the patient side may only answer an open check-in'
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
      RETURN NEW;
    END $fn$;
    CREATE TRIGGER follow_ups_guard BEFORE UPDATE ON follow_ups
      FOR EACH ROW EXECUTE FUNCTION follow_ups_guard();

    ALTER TABLE follow_ups ENABLE ROW LEVEL SECURITY;
    CREATE POLICY follow_ups_select ON follow_ups FOR SELECT USING (
      authz.is_patient_side(patient_id)
      OR doctor_user_id = authz.current_user_id()
      OR authz.system_purpose() IN ('followups', 'notifications', 'timeline'));
    CREATE POLICY follow_ups_doctor_insert ON follow_ups FOR INSERT
      WITH CHECK (doctor_user_id = authz.current_user_id() OR authz.system_purpose() = 'followups');
    CREATE POLICY follow_ups_update ON follow_ups FOR UPDATE USING (
      doctor_user_id = authz.current_user_id()
      OR authz.can_manage_patient(patient_id)
      OR authz.system_purpose() = 'followups')
      WITH CHECK (
      doctor_user_id = authz.current_user_id()
      OR authz.can_manage_patient(patient_id)
      OR authz.system_purpose() = 'followups');
    REVOKE DELETE, TRUNCATE ON follow_ups FROM "${app}";

    -- Workers creating follow-ups from consultation outcomes read the consultation.
    CREATE POLICY consultations_followups_select ON consultations FOR SELECT
      USING (authz.system_purpose() = 'followups');

    CREATE TABLE follow_up_responses (
      id uuid PRIMARY KEY,
      follow_up_id uuid NOT NULL UNIQUE REFERENCES follow_ups (id) ON DELETE RESTRICT,
      patient_id uuid NOT NULL REFERENCES patients (id) ON DELETE RESTRICT,
      responder_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
      overall text NOT NULL CHECK (overall IN ('better', 'same', 'worse')),
      red_flags text[] NOT NULL DEFAULT '{}' CHECK (red_flags <@ ARRAY['chest_pain',
        'breathing_difficulty', 'confusion', 'fainting', 'severe_bleeding', 'seizure',
        'persistent_high_fever', 'severe_allergic_reaction']::text[]),
      note_enc bytea CHECK (note_enc IS NULL OR octet_length(note_enc) <= 8192),
      key_id text CHECK (key_id IS NULL OR key_id ~ '^[a-z0-9_-]{1,32}$'),
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT responses_note_consistent CHECK ((note_enc IS NULL) = (key_id IS NULL))
    );
    ALTER TABLE follow_up_responses ENABLE ROW LEVEL SECURITY;
    CREATE POLICY responses_select ON follow_up_responses FOR SELECT USING (
      authz.is_patient_side(patient_id)
      OR EXISTS (SELECT 1 FROM follow_ups f WHERE f.id = follow_up_id
                  AND f.doctor_user_id = authz.current_user_id())
      OR authz.system_purpose() = 'followups');
    CREATE POLICY responses_insert ON follow_up_responses FOR INSERT WITH CHECK (
      authz.can_manage_patient(patient_id) AND responder_user_id = authz.current_user_id());
    REVOKE UPDATE, DELETE, TRUNCATE ON follow_up_responses FROM "${app}";

    -- ── AI follow-up summaries (written by the AI service) ────────
    CREATE TABLE ai.follow_up_summaries (
      id uuid PRIMARY KEY,
      follow_up_id uuid NOT NULL,
      patient_id uuid NOT NULL,
      doctor_user_id uuid NOT NULL,
      run_id uuid NOT NULL REFERENCES ai.ai_runs (id) ON DELETE RESTRICT,
      status text NOT NULL CHECK (status IN ('ready', 'insufficient_information')),
      sentences jsonb NOT NULL DEFAULT '[]' CHECK (pg_column_size(sentences) <= 16384),
      removed_sentence_count integer NOT NULL DEFAULT 0,
      prompt_version text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX follow_up_summaries_idx ON ai.follow_up_summaries (follow_up_id, created_at DESC);
    REVOKE DELETE, TRUNCATE, UPDATE ON ai.follow_up_summaries FROM "${ai}";
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ai.follow_up_summaries FROM "${app}";
    ALTER TABLE ai.follow_up_summaries ENABLE ROW LEVEL SECURITY;
    CREATE POLICY follow_up_summaries_scope ON ai.follow_up_summaries FOR ALL TO "${ai}"
      USING (patient_id = ai.scope_patient_id()) WITH CHECK (patient_id = ai.scope_patient_id());
    CREATE POLICY follow_up_summaries_app_select ON ai.follow_up_summaries FOR SELECT TO "${app}"
      USING (doctor_user_id = authz.current_user_id());
    ALTER TABLE ai.ai_sources DROP CONSTRAINT ai_sources_source_type_check;
    ALTER TABLE ai.ai_sources ADD CONSTRAINT ai_sources_source_type_check CHECK (source_type IN
      ('medical_document', 'document_chunk', 'lab_result', 'medical_event', 'follow_up_response'));

    -- ── In-app notifications ──────────────────────────────────────
    CREATE TABLE inbox_notifications (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
      template text NOT NULL CHECK (template ~ '^[a-z_]{1,48}$'),
      title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
      body text NOT NULL CHECK (char_length(body) <= 600),
      link text CHECK (link IS NULL OR link ~ '^/app/[A-Za-z0-9/_?=&-]{0,200}$'),
      priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'urgent')),
      dedupe_key text NOT NULL UNIQUE CHECK (char_length(dedupe_key) <= 200),
      created_at timestamptz NOT NULL DEFAULT now(),
      read_at timestamptz
    );
    CREATE INDEX inbox_user_idx ON inbox_notifications (user_id, created_at DESC, id DESC);
    CREATE INDEX inbox_unread_idx ON inbox_notifications (user_id) WHERE read_at IS NULL;

    -- Owners may only mark their notifications read.
    CREATE FUNCTION inbox_notifications_guard() RETURNS trigger
      LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
    BEGIN
      IF NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id OR NEW.template <> OLD.template
         OR NEW.title <> OLD.title OR NEW.body <> OLD.body
         OR NEW.link IS DISTINCT FROM OLD.link OR NEW.priority <> OLD.priority
         OR NEW.dedupe_key <> OLD.dedupe_key OR NEW.created_at <> OLD.created_at
         OR (OLD.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at) THEN
        RAISE EXCEPTION 'only the read time of a notification can change'
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END $fn$;
    CREATE TRIGGER inbox_notifications_guard BEFORE UPDATE ON inbox_notifications
      FOR EACH ROW EXECUTE FUNCTION inbox_notifications_guard();

    ALTER TABLE inbox_notifications ENABLE ROW LEVEL SECURITY;
    CREATE POLICY inbox_own_select ON inbox_notifications FOR SELECT USING (
      user_id = authz.current_user_id() OR authz.system_purpose() = 'notifications');
    CREATE POLICY inbox_own_update ON inbox_notifications FOR UPDATE
      USING (user_id = authz.current_user_id()) WITH CHECK (user_id = authz.current_user_id());
    CREATE POLICY inbox_system_insert ON inbox_notifications FOR INSERT
      WITH CHECK (authz.system_purpose() = 'notifications');
    REVOKE DELETE, TRUNCATE ON inbox_notifications FROM "${app}";

    -- The doctor of a follow-up, as a notification recipient (notification worker only).
    CREATE FUNCTION authz.doctor_recipient(p_doctor uuid)
      RETURNS TABLE (user_id uuid, email text, display_name text)
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
      SELECT u.id, u.email::text, d.professional_name
        FROM doctors d JOIN users u ON u.id = d.user_id
       WHERE d.id = p_doctor AND d.deleted_at IS NULL AND u.status = 'active'
         AND u.deleted_at IS NULL AND authz.system_purpose() = 'notifications'
    $fn$;
    REVOKE ALL ON FUNCTION authz.doctor_recipient(uuid) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION authz.doctor_recipient(uuid) TO "${app}";

    ALTER TABLE notification_deliveries DROP CONSTRAINT deliveries_template_valid;
    ALTER TABLE notification_deliveries ADD CONSTRAINT deliveries_template_valid
      CHECK (template IN ${M10_TEMPLATES});

    ${eventsPolicy(EVENTS.m10)}
    -- The follow-up worker also needs to know (only) whether the patient opted in to AI.
    CREATE OR REPLACE FUNCTION authz.ai_processing_enabled(p_patient uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
      SELECT coalesce((SELECT p.ai_document_processing FROM patients p
                        WHERE p.id = p_patient AND p.deleted_at IS NULL), false)
         AND authz.system_purpose() IN ('documents', 'followups')
    $fn$;

    COMMENT ON TABLE follow_ups IS 'Follow-up check-ins; escalation by deterministic rules (ADR-0026).';
    COMMENT ON TABLE inbox_notifications IS 'In-app notifications; generic wording only (ADR-0026).';
  `);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw(`
    DELETE FROM medical_events WHERE event_type = 'follow_up';
    ${eventsPolicy(EVENTS.m9)}

    CREATE OR REPLACE FUNCTION authz.ai_processing_enabled(p_patient uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
      SELECT coalesce((SELECT p.ai_document_processing FROM patients p
                        WHERE p.id = p_patient AND p.deleted_at IS NULL), false)
         AND authz.system_purpose() IN ('documents')
    $fn$;
    ALTER TABLE notification_deliveries DROP CONSTRAINT deliveries_template_valid;
    ALTER TABLE notification_deliveries ADD CONSTRAINT deliveries_template_valid
      CHECK (template IN ${M9_TEMPLATES}) NOT VALID;
    DROP FUNCTION IF EXISTS authz.doctor_recipient(uuid);
    DROP TABLE IF EXISTS inbox_notifications;
    DROP FUNCTION IF EXISTS inbox_notifications_guard();
    DELETE FROM ai.ai_sources WHERE source_type = 'follow_up_response';
    ALTER TABLE ai.ai_sources DROP CONSTRAINT ai_sources_source_type_check;
    ALTER TABLE ai.ai_sources ADD CONSTRAINT ai_sources_source_type_check CHECK (source_type IN
      ('medical_document', 'document_chunk', 'lab_result', 'medical_event'));
    DROP TABLE IF EXISTS ai.follow_up_summaries;
    DROP TABLE IF EXISTS follow_up_responses;
    DROP POLICY IF EXISTS consultations_followups_select ON consultations;
    DROP TABLE IF EXISTS follow_ups;
    DROP FUNCTION IF EXISTS follow_ups_guard();
    ${systemPurposeFn(M9_PURPOSES)}
  `);
  const codes = NEW_PERMISSIONS.map(([code]) => code);
  await knex('role_permissions')
    .whereIn('permission_id', knex('permissions').select('id').whereIn('code', codes))
    .del();
  await knex('permissions').whereIn('code', codes).del();
}
