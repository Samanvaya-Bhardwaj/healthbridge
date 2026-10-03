/**
 * M9: consultations, clinical notes and prescriptions (ADR-0025, ADR-0009).
 *
 * - `consultations`: one per appointment, created when the doctor starts it; the outcome
 *   (A/B/C) is recorded once, by the doctor, and is then immutable.
 * - `consultation_presence`: the patient's waiting-room heartbeat (patient side writes).
 * - `clinical_notes`: SOAP notes, envelope-encrypted by the application; versioned:
 *   draft → signed → superseded by a signed correction (with a reason). Signed content
 *   never changes (trigger), nothing is deleted.
 * - `prescriptions` + `prescription_items`: draft → signed (content hash + integrity seal)
 *   → superseded; draft → cancelled. Items are frozen with their prescription. The PDF is
 *   rendered once by the `prescriptions` worker; its key and hash are set once.
 *
 * Visibility (RLS): the patient side sees signed records; the authoring doctor sees their
 * own; other doctors see signed prescriptions only with an active `medical_documents`
 * consent covering the `prescription` document type. Platform admins and support: none.
 */

const NEW_PERMISSIONS = [
  ['consultations:conduct', 'Start own consultations, write clinical notes and record outcomes'],
];
const NEW_ROLE_PERMISSIONS = { DOCTOR: ['consultations:conduct'] };

const M7_PURPOSES = `('payments', 'scheduler', 'notifications', 'documents', 'consents', 'timeline')`;
const M9_PURPOSES = `('payments', 'scheduler', 'notifications', 'documents', 'consents', 'timeline', 'prescriptions')`;
const systemPurposeFn = (purposes) => `
  CREATE OR REPLACE FUNCTION authz.system_purpose() RETURNS text
    LANGUAGE sql STABLE SET search_path = pg_catalog AS $fn$
    SELECT CASE
      WHEN authz.current_user_id() IS NULL
       AND current_setting('app.system_purpose', true) IN ${purposes}
      THEN current_setting('app.system_purpose', true)
    END
  $fn$;`;

const M5_TEMPLATES = `('appointment_booked', 'payment_required', 'payment_confirmed', 'payment_failed',
  'appointment_cancelled', 'appointment_rescheduled', 'appointment_expired',
  'appointment_reminder', 'payment_refunded', 'document_available', 'document_rejected')`;
const M9_TEMPLATES = `('appointment_booked', 'payment_required', 'payment_confirmed', 'payment_failed',
  'appointment_cancelled', 'appointment_rescheduled', 'appointment_expired',
  'appointment_reminder', 'payment_refunded', 'document_available', 'document_rejected',
  'prescription_available', 'in_person_visit_requested', 'emergency_guidance')`;

const EVENT_CHECKS = {
  m7: {
    event: `('appointment', 'document', 'lab_result')`,
    source: `('appointment', 'medical_document', 'lab_result')`,
  },
  m9: {
    event: `('appointment', 'document', 'lab_result', 'consultation', 'prescription')`,
    source: `('appointment', 'medical_document', 'lab_result', 'consultation', 'prescription')`,
  },
};

const eventsSelectPolicy = (m9) => `
  CREATE POLICY medical_events_select ON medical_events FOR SELECT USING (
    authz.is_patient_side(patient_id)
    OR (event_type IN ${m9 ? `('document', 'lab_result', 'prescription')` : `('document', 'lab_result')`}
        AND authz.has_consent(patient_id, 'medical_documents', document_type))
    OR (event_type IN ${m9 ? `('appointment', 'consultation', 'prescription')` : `('appointment')`}
        AND doctor_user_id = authz.current_user_id())
    OR authz.system_purpose() = 'timeline');`;

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
    ${systemPurposeFn(M9_PURPOSES)}

    -- ── Consultations ─────────────────────────────────────────────
    CREATE TABLE consultations (
      id uuid PRIMARY KEY,
      appointment_id uuid NOT NULL UNIQUE REFERENCES appointments (id) ON DELETE RESTRICT,
      patient_id uuid NOT NULL REFERENCES patients (id) ON DELETE RESTRICT,
      doctor_id uuid NOT NULL REFERENCES doctors (id) ON DELETE RESTRICT,
      doctor_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
      clinic_id uuid REFERENCES clinics (id) ON DELETE RESTRICT,
      mode text NOT NULL CHECK (mode IN ('online', 'in_clinic')),
      status text NOT NULL DEFAULT 'live' CHECK (status IN ('live', 'ended')),
      video_provider text CHECK (video_provider IS NULL OR video_provider IN ('mock', 'livekit')),
      video_room_ref text CHECK (video_room_ref IS NULL OR video_room_ref ~ '^[A-Za-z0-9_-]{8,80}$'),
      started_at timestamptz NOT NULL DEFAULT now(),
      ended_at timestamptz,
      outcome text CHECK (outcome IS NULL OR outcome IN
        ('online_managed', 'physical_visit_required', 'emergency_escalation')),
      outcome_detail jsonb NOT NULL DEFAULT '{}' CHECK (pg_column_size(outcome_detail) <= 2048),
      outcome_recorded_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT consultations_outcome_consistent CHECK (
        (status = 'ended') = (outcome IS NOT NULL)
        AND (outcome IS NULL) = (outcome_recorded_at IS NULL)
        AND (status = 'ended') = (ended_at IS NOT NULL)),
      CONSTRAINT consultations_video_consistent CHECK (
        (mode = 'online') = (video_room_ref IS NOT NULL))
    );
    CREATE INDEX consultations_patient_idx ON consultations (patient_id, started_at DESC);

    -- Outcome and identity never change once recorded (ADR-0009).
    CREATE FUNCTION consultations_guard() RETURNS trigger
      LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
    BEGIN
      IF NEW.id <> OLD.id OR NEW.appointment_id <> OLD.appointment_id
         OR NEW.patient_id <> OLD.patient_id OR NEW.doctor_id <> OLD.doctor_id
         OR NEW.doctor_user_id <> OLD.doctor_user_id OR NEW.mode <> OLD.mode
         OR NEW.started_at <> OLD.started_at
         OR NEW.video_room_ref IS DISTINCT FROM OLD.video_room_ref THEN
        RAISE EXCEPTION 'consultation identity is immutable' USING ERRCODE = 'check_violation';
      END IF;
      IF OLD.status = 'ended' THEN
        RAISE EXCEPTION 'an ended consultation is immutable' USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END $fn$;
    CREATE TRIGGER consultations_guard BEFORE UPDATE ON consultations
      FOR EACH ROW EXECUTE FUNCTION consultations_guard();

    ALTER TABLE consultations ENABLE ROW LEVEL SECURITY;
    CREATE POLICY consultations_select ON consultations FOR SELECT USING (
      authz.is_patient_side(patient_id)
      OR doctor_user_id = authz.current_user_id()
      OR authz.system_purpose() IN ('notifications', 'timeline', 'prescriptions'));
    CREATE POLICY consultations_insert ON consultations FOR INSERT
      WITH CHECK (doctor_user_id = authz.current_user_id());
    CREATE POLICY consultations_update ON consultations FOR UPDATE
      USING (doctor_user_id = authz.current_user_id())
      WITH CHECK (doctor_user_id = authz.current_user_id());
    REVOKE DELETE, TRUNCATE ON consultations FROM "${app}";

    -- ── Waiting room presence (patient side) ──────────────────────
    CREATE TABLE consultation_presence (
      appointment_id uuid PRIMARY KEY REFERENCES appointments (id) ON DELETE RESTRICT,
      patient_id uuid NOT NULL REFERENCES patients (id) ON DELETE RESTRICT,
      doctor_id uuid NOT NULL REFERENCES doctors (id) ON DELETE RESTRICT,
      arrived_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT
    );
    ALTER TABLE consultation_presence ENABLE ROW LEVEL SECURITY;
    CREATE POLICY presence_select ON consultation_presence FOR SELECT USING (
      authz.is_patient_side(patient_id) OR authz.is_doctor_user(doctor_id));
    CREATE POLICY presence_insert ON consultation_presence FOR INSERT
      WITH CHECK (authz.is_patient_side(patient_id) AND user_id = authz.current_user_id());
    CREATE POLICY presence_update ON consultation_presence FOR UPDATE
      USING (authz.is_patient_side(patient_id))
      WITH CHECK (authz.is_patient_side(patient_id) AND user_id = authz.current_user_id());
    REVOKE DELETE, TRUNCATE ON consultation_presence FROM "${app}";

    -- ── Clinical notes (SOAP, envelope-encrypted) ─────────────────
    CREATE TABLE clinical_notes (
      id uuid PRIMARY KEY,
      consultation_id uuid NOT NULL REFERENCES consultations (id) ON DELETE RESTRICT,
      patient_id uuid NOT NULL REFERENCES patients (id) ON DELETE RESTRICT,
      doctor_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
      version integer NOT NULL CHECK (version >= 1),
      status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'signed', 'superseded')),
      content_enc bytea NOT NULL CHECK (octet_length(content_enc) <= 65536),
      key_id text NOT NULL CHECK (key_id ~ '^[a-z0-9_-]{1,32}$'),
      supersedes_id uuid REFERENCES clinical_notes (id) ON DELETE RESTRICT,
      correction_reason text CHECK (correction_reason IS NULL OR char_length(correction_reason) <= 500),
      signed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (consultation_id, version),
      CONSTRAINT notes_signed_consistent CHECK ((status = 'draft') = (signed_at IS NULL)),
      CONSTRAINT notes_correction_consistent CHECK ((supersedes_id IS NULL) = (correction_reason IS NULL))
    );
    CREATE UNIQUE INDEX clinical_notes_one_draft ON clinical_notes (consultation_id) WHERE status = 'draft';
    CREATE UNIQUE INDEX clinical_notes_one_current ON clinical_notes (consultation_id) WHERE status = 'signed';

    CREATE FUNCTION clinical_notes_immutable() RETURNS trigger
      LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'clinical notes are never deleted' USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.id <> OLD.id OR NEW.consultation_id <> OLD.consultation_id
         OR NEW.patient_id <> OLD.patient_id OR NEW.doctor_user_id <> OLD.doctor_user_id
         OR NEW.version <> OLD.version
         OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id THEN
        RAISE EXCEPTION 'clinical note identity is immutable' USING ERRCODE = 'check_violation';
      END IF;
      IF OLD.status = 'draft' THEN RETURN NEW; END IF;
      -- Signed: the only change is signed → superseded, with the content untouched.
      IF OLD.status = 'signed' AND NEW.status = 'superseded'
         AND NEW.content_enc = OLD.content_enc AND NEW.key_id = OLD.key_id
         AND NEW.signed_at = OLD.signed_at
         AND NEW.correction_reason IS NOT DISTINCT FROM OLD.correction_reason THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'a signed clinical note is immutable' USING ERRCODE = 'check_violation';
    END $fn$;
    CREATE TRIGGER clinical_notes_immutable BEFORE UPDATE OR DELETE ON clinical_notes
      FOR EACH ROW EXECUTE FUNCTION clinical_notes_immutable();

    ALTER TABLE clinical_notes ENABLE ROW LEVEL SECURITY;
    CREATE POLICY clinical_notes_select ON clinical_notes FOR SELECT USING (
      doctor_user_id = authz.current_user_id()
      OR (status IN ('signed', 'superseded') AND authz.is_patient_side(patient_id)));
    CREATE POLICY clinical_notes_insert ON clinical_notes FOR INSERT
      WITH CHECK (doctor_user_id = authz.current_user_id());
    CREATE POLICY clinical_notes_update ON clinical_notes FOR UPDATE
      USING (doctor_user_id = authz.current_user_id())
      WITH CHECK (doctor_user_id = authz.current_user_id());
    REVOKE DELETE, TRUNCATE ON clinical_notes FROM "${app}";

    -- ── Prescriptions ─────────────────────────────────────────────
    CREATE TABLE prescriptions (
      id uuid PRIMARY KEY,
      reference text NOT NULL CHECK (reference ~ '^RX-[0-9A-Z]{10}$'),
      consultation_id uuid NOT NULL REFERENCES consultations (id) ON DELETE RESTRICT,
      appointment_id uuid NOT NULL REFERENCES appointments (id) ON DELETE RESTRICT,
      patient_id uuid NOT NULL REFERENCES patients (id) ON DELETE RESTRICT,
      doctor_id uuid NOT NULL REFERENCES doctors (id) ON DELETE RESTRICT,
      doctor_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
      clinic_id uuid REFERENCES clinics (id) ON DELETE RESTRICT,
      version integer NOT NULL CHECK (version >= 1),
      status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'signed', 'superseded', 'cancelled')),
      advice text NOT NULL DEFAULT '' CHECK (char_length(advice) <= 2000),
      supersedes_id uuid REFERENCES prescriptions (id) ON DELETE RESTRICT,
      correction_reason text CHECK (correction_reason IS NULL OR char_length(correction_reason) <= 500),
      content_sha256 text CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'),
      integrity_seal text CHECK (integrity_seal IS NULL OR integrity_seal ~ '^[0-9a-f]{64}$'),
      seal_key_id text CHECK (seal_key_id IS NULL OR seal_key_id ~ '^[a-z0-9_-]{1,32}$'),
      signed_at timestamptz,
      pdf_object_key text CHECK (pdf_object_key IS NULL OR pdf_object_key ~ '^prescriptions/[0-9a-f-]{36}/[0-9a-f-]{36}-v[0-9]+[.]pdf$'),
      pdf_sha256 text CHECK (pdf_sha256 IS NULL OR pdf_sha256 ~ '^[0-9a-f]{64}$'),
      pdf_generated_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (consultation_id, version),
      -- A correction keeps the chain's reference; each version is unique within it.
      UNIQUE (reference, version),
      CONSTRAINT prescriptions_signed_consistent CHECK (
        (status IN ('signed', 'superseded')) = (signed_at IS NOT NULL)
        AND (signed_at IS NULL) = (content_sha256 IS NULL)
        AND (signed_at IS NULL) = (integrity_seal IS NULL)
        AND (signed_at IS NULL) = (seal_key_id IS NULL)),
      CONSTRAINT prescriptions_pdf_consistent CHECK (
        (pdf_object_key IS NULL) = (pdf_sha256 IS NULL)
        AND (pdf_object_key IS NULL) = (pdf_generated_at IS NULL)
        AND (pdf_object_key IS NULL OR signed_at IS NOT NULL)),
      CONSTRAINT prescriptions_correction_consistent CHECK ((supersedes_id IS NULL) = (correction_reason IS NULL))
    );
    CREATE UNIQUE INDEX prescriptions_one_draft ON prescriptions (consultation_id) WHERE status = 'draft';
    CREATE INDEX prescriptions_patient_idx ON prescriptions (patient_id, signed_at DESC);

    CREATE TABLE prescription_items (
      id uuid PRIMARY KEY,
      prescription_id uuid NOT NULL REFERENCES prescriptions (id) ON DELETE RESTRICT,
      patient_id uuid NOT NULL REFERENCES patients (id) ON DELETE RESTRICT,
      position smallint NOT NULL CHECK (position BETWEEN 1 AND 20),
      drug_name text NOT NULL CHECK (char_length(drug_name) BETWEEN 2 AND 120),
      strength text NOT NULL DEFAULT '' CHECK (char_length(strength) <= 60),
      form text NOT NULL DEFAULT '' CHECK (char_length(form) <= 40),
      dose text NOT NULL CHECK (char_length(dose) BETWEEN 1 AND 60),
      frequency text NOT NULL CHECK (char_length(frequency) BETWEEN 1 AND 60),
      route text NOT NULL CHECK (route IN ('oral', 'topical', 'inhalation', 'nasal', 'ophthalmic',
        'otic', 'sublingual', 'rectal', 'vaginal', 'transdermal', 'other')),
      duration text NOT NULL CHECK (char_length(duration) BETWEEN 1 AND 60),
      instructions text NOT NULL DEFAULT '' CHECK (char_length(instructions) <= 300),
      UNIQUE (prescription_id, position)
    );

    CREATE FUNCTION prescriptions_immutable() RETURNS trigger
      LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'prescriptions are never deleted' USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.id <> OLD.id OR NEW.reference <> OLD.reference
         OR NEW.consultation_id <> OLD.consultation_id OR NEW.patient_id <> OLD.patient_id
         OR NEW.doctor_user_id <> OLD.doctor_user_id OR NEW.version <> OLD.version
         OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id THEN
        RAISE EXCEPTION 'prescription identity is immutable' USING ERRCODE = 'check_violation';
      END IF;
      IF OLD.status = 'draft' THEN RETURN NEW; END IF;
      IF OLD.status = 'cancelled' THEN
        RAISE EXCEPTION 'a cancelled prescription is immutable' USING ERRCODE = 'check_violation';
      END IF;
      -- Signed (or superseded): content, hash and seal are frozen. Allowed: the one-time
      -- PDF fields, and signed → superseded.
      IF NEW.advice <> OLD.advice OR NEW.content_sha256 <> OLD.content_sha256
         OR NEW.integrity_seal <> OLD.integrity_seal OR NEW.seal_key_id <> OLD.seal_key_id
         OR NEW.signed_at <> OLD.signed_at
         OR NEW.correction_reason IS DISTINCT FROM OLD.correction_reason
         OR (OLD.pdf_object_key IS NOT NULL AND (NEW.pdf_object_key IS DISTINCT FROM OLD.pdf_object_key
             OR NEW.pdf_sha256 IS DISTINCT FROM OLD.pdf_sha256
             OR NEW.pdf_generated_at IS DISTINCT FROM OLD.pdf_generated_at))
         OR (NEW.status <> OLD.status AND NOT (OLD.status = 'signed' AND NEW.status = 'superseded')) THEN
        RAISE EXCEPTION 'a signed prescription is immutable' USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END $fn$;
    CREATE TRIGGER prescriptions_immutable BEFORE UPDATE OR DELETE ON prescriptions
      FOR EACH ROW EXECUTE FUNCTION prescriptions_immutable();

    -- Items change only while their prescription is a draft.
    CREATE FUNCTION prescription_items_frozen() RETURNS trigger
      LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
    DECLARE parent_status text;
    BEGIN
      SELECT status INTO parent_status FROM prescriptions
       WHERE id = (CASE WHEN TG_OP = 'INSERT' THEN NEW.prescription_id ELSE OLD.prescription_id END);
      IF parent_status IS DISTINCT FROM 'draft' THEN
        RAISE EXCEPTION 'prescription items are frozen once signed' USING ERRCODE = 'check_violation';
      END IF;
      IF TG_OP = 'UPDATE' AND NEW.prescription_id <> OLD.prescription_id THEN
        RAISE EXCEPTION 'prescription items cannot move' USING ERRCODE = 'check_violation';
      END IF;
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END $fn$;
    CREATE TRIGGER prescription_items_frozen BEFORE INSERT OR UPDATE OR DELETE ON prescription_items
      FOR EACH ROW EXECUTE FUNCTION prescription_items_frozen();

    ALTER TABLE prescriptions ENABLE ROW LEVEL SECURITY;
    CREATE POLICY prescriptions_select ON prescriptions FOR SELECT USING (
      doctor_user_id = authz.current_user_id()
      OR (status IN ('signed', 'superseded') AND (
            authz.is_patient_side(patient_id)
            OR authz.has_consent(patient_id, 'medical_documents', 'prescription')))
      OR authz.system_purpose() IN ('prescriptions', 'timeline', 'notifications'));
    CREATE POLICY prescriptions_insert ON prescriptions FOR INSERT
      WITH CHECK (doctor_user_id = authz.current_user_id());
    CREATE POLICY prescriptions_update ON prescriptions FOR UPDATE
      USING (doctor_user_id = authz.current_user_id())
      WITH CHECK (doctor_user_id = authz.current_user_id());
    -- The PDF renderer sets the one-time PDF fields (the trigger enforces the rest).
    CREATE POLICY prescriptions_pdf_update ON prescriptions FOR UPDATE
      USING (authz.system_purpose() = 'prescriptions')
      WITH CHECK (authz.system_purpose() = 'prescriptions');
    REVOKE DELETE, TRUNCATE ON prescriptions FROM "${app}";

    ALTER TABLE prescription_items ENABLE ROW LEVEL SECURITY;
    -- Visible exactly when the parent prescription is (RLS applies inside the subquery).
    CREATE POLICY prescription_items_select ON prescription_items FOR SELECT USING (
      EXISTS (SELECT 1 FROM prescriptions p WHERE p.id = prescription_id));
    CREATE POLICY prescription_items_insert ON prescription_items FOR INSERT WITH CHECK (
      EXISTS (SELECT 1 FROM prescriptions p WHERE p.id = prescription_id
               AND p.doctor_user_id = authz.current_user_id() AND p.patient_id = prescription_items.patient_id));
    CREATE POLICY prescription_items_delete ON prescription_items FOR DELETE USING (
      EXISTS (SELECT 1 FROM prescriptions p WHERE p.id = prescription_id
               AND p.doctor_user_id = authz.current_user_id()));
    REVOKE UPDATE, TRUNCATE ON prescription_items FROM "${app}";

    -- The PDF renderer needs the patient's name and date of birth.
    CREATE POLICY patients_prescriptions_select ON patients FOR SELECT
      USING (authz.system_purpose() = 'prescriptions');
    CREATE POLICY appointments_prescriptions_select ON appointments FOR SELECT
      USING (authz.system_purpose() = 'prescriptions');

    -- ── Timeline projection of consultations and prescriptions ────
    ALTER TABLE medical_events DROP CONSTRAINT medical_events_event_type_check;
    ALTER TABLE medical_events ADD CONSTRAINT medical_events_event_type_check
      CHECK (event_type IN ${EVENT_CHECKS.m9.event});
    ALTER TABLE medical_events DROP CONSTRAINT medical_events_source_type_check;
    ALTER TABLE medical_events ADD CONSTRAINT medical_events_source_type_check
      CHECK (source_type IN ${EVENT_CHECKS.m9.source});
    DROP POLICY medical_events_select ON medical_events;
    ${eventsSelectPolicy(true)}

    ALTER TABLE notification_deliveries DROP CONSTRAINT deliveries_template_valid;
    ALTER TABLE notification_deliveries ADD CONSTRAINT deliveries_template_valid
      CHECK (template IN ${M9_TEMPLATES});

    COMMENT ON TABLE clinical_notes IS 'SOAP notes, envelope-encrypted by the application; signed versions immutable (ADR-0009, ADR-0025).';
    COMMENT ON TABLE prescriptions IS 'Prescriptions; signed versions immutable, corrections supersede (ADR-0009, ADR-0025).';
  `);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw(`
    DELETE FROM medical_events WHERE event_type IN ('consultation', 'prescription');
    ALTER TABLE medical_events DROP CONSTRAINT medical_events_event_type_check;
    ALTER TABLE medical_events ADD CONSTRAINT medical_events_event_type_check
      CHECK (event_type IN ${EVENT_CHECKS.m7.event});
    ALTER TABLE medical_events DROP CONSTRAINT medical_events_source_type_check;
    ALTER TABLE medical_events ADD CONSTRAINT medical_events_source_type_check
      CHECK (source_type IN ${EVENT_CHECKS.m7.source});
    DROP POLICY medical_events_select ON medical_events;
    ${eventsSelectPolicy(false)}

    ALTER TABLE notification_deliveries DROP CONSTRAINT deliveries_template_valid;
    -- Delivery rows are history: rows with M9 templates keep them (NOT VALID).
    ALTER TABLE notification_deliveries ADD CONSTRAINT deliveries_template_valid
      CHECK (template IN ${M5_TEMPLATES}) NOT VALID;

    DROP POLICY IF EXISTS patients_prescriptions_select ON patients;
    DROP POLICY IF EXISTS appointments_prescriptions_select ON appointments;
    DROP TABLE IF EXISTS prescription_items;
    DROP TABLE IF EXISTS prescriptions;
    DROP TABLE IF EXISTS clinical_notes;
    DROP TABLE IF EXISTS consultation_presence;
    DROP TABLE IF EXISTS consultations;
    DROP FUNCTION IF EXISTS prescription_items_frozen();
    DROP FUNCTION IF EXISTS prescriptions_immutable();
    DROP FUNCTION IF EXISTS clinical_notes_immutable();
    DROP FUNCTION IF EXISTS consultations_guard();
    ${systemPurposeFn(M7_PURPOSES)}
  `);
  const codes = NEW_PERMISSIONS.map(([code]) => code);
  await knex('role_permissions')
    .whereIn('permission_id', knex('permissions').select('id').whereIn('code', codes))
    .del();
  await knex('permissions').whereIn('code', codes).del();
}
