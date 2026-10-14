/**
 * Step 4 of the delivery plan: one eligibility rule for search, slots and booking.
 *
 * A doctor is BOOKABLE when the doctor profile is active and verified and the doctor's
 * user account is active (none of them deleted). A practice site — the clinic named by an
 * availability rule or an appointment — is OPEN for that doctor when there is no clinic
 * (independent online practice), or the clinic is active and the doctor's DOCTOR
 * membership there is active.
 *
 * - `authz.doctor_is_bookable(doctor)` and `authz.practice_site_open(doctor, clinic)` are
 *   the single definition. The directory, slot generation and booking all use them.
 * - `appointments_eligibility_guard` (BEFORE INSERT) is the database authority at booking
 *   time, as the EXCLUDE constraint is for overlaps. It reads the doctor, user, clinic and
 *   membership rows FOR SHARE. A concurrent change of any of them (clinic closed, doctor
 *   left or was suspended, account disabled) therefore either waits for the booking to
 *   commit, so the clean-up that change triggers sees the booking, or commits first, so
 *   the booking is refused. There is no window in which a booking slips through.
 * - Existing future bookings that stop being eligible are cancelled by the system (full
 *   refund, patient notice `appointment_withdrawn`): see appointmentService.withdrawIneligible.
 */

const M10_TEMPLATES = `('appointment_booked', 'payment_required', 'payment_confirmed', 'payment_failed',
  'appointment_cancelled', 'appointment_rescheduled', 'appointment_expired',
  'appointment_reminder', 'payment_refunded', 'document_available', 'document_rejected',
  'prescription_available', 'in_person_visit_requested', 'emergency_guidance',
  'follow_up_due', 'follow_up_attention', 'follow_up_urgent')`;
const TEMPLATES = M10_TEMPLATES.replace(
  `'follow_up_urgent')`,
  `'follow_up_urgent', 'appointment_withdrawn')`,
);

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  const app = process.env.DB_APP_USER ?? 'hb_app';
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(app)) throw new Error(`Invalid role name: ${app}`);

  await knex.raw(`
    CREATE FUNCTION authz.doctor_is_bookable(p_doctor uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
      SELECT EXISTS (
        SELECT 1 FROM doctors d JOIN users u ON u.id = d.user_id
         WHERE d.id = p_doctor AND d.deleted_at IS NULL
           AND d.profile_status = 'active' AND d.verification_status = 'verified'
           AND u.status = 'active' AND u.deleted_at IS NULL)
    $fn$;

    CREATE FUNCTION authz.practice_site_open(p_doctor uuid, p_clinic uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
      SELECT p_clinic IS NULL OR EXISTS (
        SELECT 1 FROM doctors d
          JOIN clinic_memberships m ON m.user_id = d.user_id
          JOIN clinics c ON c.id = m.clinic_id
         WHERE d.id = p_doctor AND c.id = p_clinic
           AND c.status = 'active' AND c.deleted_at IS NULL
           AND m.member_role = 'DOCTOR' AND m.status = 'active')
    $fn$;

    GRANT EXECUTE ON FUNCTION authz.doctor_is_bookable(uuid) TO "${app}";
    GRANT EXECUTE ON FUNCTION authz.practice_site_open(uuid, uuid) TO "${app}";

    CREATE FUNCTION appointments_eligibility_guard() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
    DECLARE
      v_user uuid;
    BEGIN
      SELECT d.user_id INTO v_user
        FROM doctors d JOIN users u ON u.id = d.user_id
       WHERE d.id = NEW.doctor_id AND d.deleted_at IS NULL
         AND d.profile_status = 'active' AND d.verification_status = 'verified'
         AND u.status = 'active' AND u.deleted_at IS NULL
         FOR SHARE OF d, u;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'doctor is not bookable'
          USING ERRCODE = 'check_violation', CONSTRAINT = 'appointments_doctor_bookable';
      END IF;
      IF NEW.clinic_id IS NOT NULL THEN
        PERFORM 1
           FROM clinics c JOIN clinic_memberships m ON m.clinic_id = c.id
          WHERE c.id = NEW.clinic_id AND c.status = 'active' AND c.deleted_at IS NULL
            AND m.user_id = v_user AND m.member_role = 'DOCTOR' AND m.status = 'active'
            FOR SHARE OF c, m;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'practice site is not open for this doctor'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'appointments_practice_site_open';
        END IF;
      END IF;
      RETURN NEW;
    END $fn$;
    CREATE TRIGGER appointments_eligibility_guard BEFORE INSERT ON appointments
      FOR EACH ROW EXECUTE FUNCTION appointments_eligibility_guard();

    -- Lookups used by the rule and by the clean-up of affected future bookings.
    CREATE INDEX IF NOT EXISTS clinic_memberships_doctor_site_idx
      ON clinic_memberships (user_id, clinic_id) WHERE member_role = 'DOCTOR';
    CREATE INDEX IF NOT EXISTS appointments_open_future_idx
      ON appointments (doctor_id, starts_at) WHERE status IN ('pending_payment', 'confirmed');

    ALTER TABLE notification_deliveries DROP CONSTRAINT deliveries_template_valid;
    ALTER TABLE notification_deliveries ADD CONSTRAINT deliveries_template_valid
      CHECK (template IN ${TEMPLATES});
  `);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw(`
    ALTER TABLE notification_deliveries DROP CONSTRAINT deliveries_template_valid;
    ALTER TABLE notification_deliveries ADD CONSTRAINT deliveries_template_valid
      CHECK (template IN ${M10_TEMPLATES}) NOT VALID;
    DROP INDEX IF EXISTS appointments_open_future_idx;
    DROP INDEX IF EXISTS clinic_memberships_doctor_site_idx;
    DROP TRIGGER IF EXISTS appointments_eligibility_guard ON appointments;
    DROP FUNCTION IF EXISTS appointments_eligibility_guard();
    DROP FUNCTION IF EXISTS authz.practice_site_open(uuid, uuid);
    DROP FUNCTION IF EXISTS authz.doctor_is_bookable(uuid);
  `);
}
