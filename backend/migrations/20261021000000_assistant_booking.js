/**
 * Booking through the assistant (ADR-0038).
 *
 * - `doctors.accepts_new_patients`: a doctor may accept new patients automatically. A
 *   patient's care request to such a doctor is active at once, so booking can follow in the
 *   same conversation; otherwise the doctor accepts as before.
 * - `care_insert` now enforces that rule in the database: a patient-initiated relationship
 *   starts `pending`, or `active` only for a doctor who accepts new patients.
 * - `assistant_actions`: a booking the assistant proposed, waiting for the person's
 *   explicit Confirm. It holds structured references only (doctor, time, mode, clinic,
 *   fee), expires after 15 minutes, and belongs to the user who saw it (RLS). The model
 *   can never create or confirm one: the backend proposes from slots it re-checked, and
 *   only the confirm endpoint (a person's tap) books.
 */

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  const app = process.env.DB_APP_USER ?? 'hb_app';
  await knex.raw(`
    ALTER TABLE doctors ADD COLUMN accepts_new_patients boolean NOT NULL DEFAULT false;

    CREATE FUNCTION authz.doctor_accepts_new_patients(p_doctor uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
      SELECT coalesce((SELECT accepts_new_patients FROM doctors WHERE id = p_doctor), false)
    $fn$;
    REVOKE ALL ON FUNCTION authz.doctor_accepts_new_patients(uuid) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION authz.doctor_accepts_new_patients(uuid) TO "${app}";

    DROP POLICY care_insert ON care_relationships;
    CREATE POLICY care_insert ON care_relationships FOR INSERT WITH CHECK (
      requested_by_user_id = authz.current_user_id()
      AND ((initiated_by = 'patient' AND authz.can_manage_patient(patient_id)
            AND (status = 'pending'
                 OR (status = 'active' AND authz.doctor_accepts_new_patients(doctor_id))))
        OR (initiated_by = 'doctor' AND authz.is_doctor_user(doctor_id))));

    CREATE TABLE assistant_actions (
      id uuid PRIMARY KEY,
      session_id uuid NOT NULL REFERENCES agent_sessions (id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
      patient_id uuid NOT NULL REFERENCES patients (id) ON DELETE RESTRICT,
      kind text NOT NULL CHECK (kind IN ('book')),
      payload jsonb NOT NULL,
      status text NOT NULL DEFAULT 'proposed'
        CHECK (status IN ('proposed', 'done', 'awaiting_doctor', 'failed')),
      result jsonb,
      error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z_]{1,48}$'),
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      decided_at timestamptz,
      CONSTRAINT assistant_actions_payload_object CHECK (jsonb_typeof(payload) = 'object'),
      CONSTRAINT assistant_actions_bounded CHECK (
        pg_column_size(payload) <= 2048 AND (result IS NULL OR pg_column_size(result) <= 2048)),
      CONSTRAINT assistant_actions_short_lived CHECK (
        expires_at > created_at AND expires_at <= created_at + interval '1 hour')
    );
    CREATE INDEX assistant_actions_session_idx ON assistant_actions (session_id, created_at DESC);

    ALTER TABLE assistant_actions ENABLE ROW LEVEL SECURITY;
    CREATE POLICY assistant_actions_own ON assistant_actions FOR ALL
      USING (user_id = authz.current_user_id())
      WITH CHECK (user_id = authz.current_user_id());
    -- Rows go with their session (the retention sweep); the application never deletes.
    REVOKE DELETE, TRUNCATE ON assistant_actions FROM "${app}";

    COMMENT ON TABLE assistant_actions IS
      'Bookings the assistant proposed, waiting for the person''s Confirm (ADR-0038).';
  `);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw(`
    DROP TABLE IF EXISTS assistant_actions;
    DROP POLICY IF EXISTS care_insert ON care_relationships;
    CREATE POLICY care_insert ON care_relationships FOR INSERT WITH CHECK (
      requested_by_user_id = authz.current_user_id()
      AND ((initiated_by = 'patient' AND authz.can_manage_patient(patient_id))
        OR (initiated_by = 'doctor' AND authz.is_doctor_user(doctor_id))));
    DROP FUNCTION IF EXISTS authz.doctor_accepts_new_patients(uuid);
    ALTER TABLE doctors DROP COLUMN IF EXISTS accepts_new_patients;
  `);
}
