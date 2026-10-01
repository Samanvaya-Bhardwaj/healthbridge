/**
 * M3: availability, appointments, appointment intake (reason for visit), and the
 * transactional outbox.
 *
 * - Slots are computed on demand from availability rules (ADR-0019); the hard
 *   guarantee against double booking is the EXCLUDE constraint on appointments.
 * - Appointments and intakes are patient-scoped: RLS like M2 tables. The reason for
 *   visit lives in `appointment_intakes`, readable only by the patient side and the
 *   doctor; clinic schedulers see appointments but never the reason.
 * - `outbox_events` (ADR-0005) is written in the same transaction as each domain change;
 *   the relay to BullMQ arrives with the first consumer (M4).
 */

const ACTIVE_STATUSES = `('pending_payment', 'confirmed', 'checked_in', 'in_consultation')`;

const NEW_PERMISSIONS = [
  [
    'appointments:manage',
    'Cancel, reschedule, check in and complete appointments within relationship scope',
  ],
  ['availability:manage', 'Manage consultation availability and time off'],
];
const NEW_ROLE_PERMISSIONS = {
  PATIENT: ['appointments:manage'],
  DOCTOR: ['appointments:manage', 'availability:manage'],
  CLINIC_ADMIN: ['appointments:manage'],
};

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

  // ── Availability ────────────────────────────────────────────────
  await knex.schema.createTable('availability_rules', (t) => {
    t.uuid('id').primary();
    t.uuid('doctor_id').notNullable().references('id').inTable('doctors').onDelete('RESTRICT');
    t.uuid('clinic_id').references('id').inTable('clinics').onDelete('RESTRICT');
    t.text('mode').notNullable();
    t.smallint('weekday').notNullable(); // ISO: 1 = Monday … 7 = Sunday
    t.time('start_time').notNullable();
    t.time('end_time').notNullable();
    t.smallint('slot_minutes').notNullable();
    t.text('timezone').notNullable().defaultTo('Asia/Kolkata');
    t.date('valid_from').notNullable();
    t.date('valid_until');
    t.integer('fee_paise').notNullable().defaultTo(0);
    t.text('status').notNullable().defaultTo('active');
    t.uuid('created_by_user_id')
      .notNullable()
      .references('id')
      .inTable('users')
      .onDelete('RESTRICT');
    t.timestamps(true, true);
  });
  await knex.raw(`
    ALTER TABLE availability_rules
      ADD CONSTRAINT availability_mode_valid CHECK (mode IN ('online', 'in_clinic')),
      ADD CONSTRAINT availability_clinic_for_in_clinic CHECK (mode <> 'in_clinic' OR clinic_id IS NOT NULL),
      ADD CONSTRAINT availability_weekday_valid CHECK (weekday BETWEEN 1 AND 7),
      ADD CONSTRAINT availability_window_valid CHECK (end_time > start_time),
      ADD CONSTRAINT availability_slot_valid CHECK (slot_minutes BETWEEN 10 AND 120),
      ADD CONSTRAINT availability_slot_fits CHECK (EXTRACT(EPOCH FROM (end_time - start_time)) >= slot_minutes * 60),
      ADD CONSTRAINT availability_validity CHECK (valid_until IS NULL OR valid_until >= valid_from),
      ADD CONSTRAINT availability_fee_valid CHECK (fee_paise BETWEEN 0 AND 10000000),
      ADD CONSTRAINT availability_status_valid CHECK (status IN ('active', 'archived'));
    CREATE INDEX availability_doctor_idx ON availability_rules (doctor_id, weekday) WHERE status = 'active';
  `);

  await knex.schema.createTable('availability_exceptions', (t) => {
    t.uuid('id').primary();
    t.uuid('doctor_id').notNullable().references('id').inTable('doctors').onDelete('RESTRICT');
    t.timestamp('starts_at', { useTz: true }).notNullable();
    t.timestamp('ends_at', { useTz: true }).notNullable();
    t.text('reason_code').notNullable();
    t.uuid('created_by_user_id')
      .notNullable()
      .references('id')
      .inTable('users')
      .onDelete('RESTRICT');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('removed_at', { useTz: true });
  });
  await knex.raw(`
    ALTER TABLE availability_exceptions
      ADD CONSTRAINT exceptions_range_valid CHECK (ends_at > starts_at),
      ADD CONSTRAINT exceptions_reason_valid CHECK (reason_code IN ('leave', 'conference', 'personal', 'clinic_closed', 'other'));
    CREATE INDEX exceptions_doctor_idx ON availability_exceptions (doctor_id, starts_at) WHERE removed_at IS NULL;
  `);

  // ── Appointments ────────────────────────────────────────────────
  await knex.schema.createTable('appointments', (t) => {
    t.uuid('id').primary();
    t.uuid('patient_id').notNullable().references('id').inTable('patients').onDelete('RESTRICT');
    t.uuid('doctor_id').notNullable().references('id').inTable('doctors').onDelete('RESTRICT');
    t.uuid('clinic_id').references('id').inTable('clinics').onDelete('RESTRICT');
    t.uuid('availability_rule_id')
      .references('id')
      .inTable('availability_rules')
      .onDelete('RESTRICT');
    t.uuid('care_relationship_id')
      .notNullable()
      .references('id')
      .inTable('care_relationships')
      .onDelete('RESTRICT');
    t.text('mode').notNullable();
    t.text('status').notNullable();
    t.timestamp('starts_at', { useTz: true }).notNullable();
    t.timestamp('ends_at', { useTz: true }).notNullable();
    t.integer('fee_paise').notNullable().defaultTo(0);
    t.specificType('currency', 'char(3)').notNullable().defaultTo('INR');
    t.timestamp('hold_expires_at', { useTz: true });
    t.uuid('booked_by_user_id')
      .notNullable()
      .references('id')
      .inTable('users')
      .onDelete('RESTRICT');
    t.text('idempotency_key');
    t.uuid('rescheduled_from_id').references('id').inTable('appointments').onDelete('RESTRICT');
    t.timestamp('confirmed_at', { useTz: true });
    t.timestamp('checked_in_at', { useTz: true });
    t.timestamp('completed_at', { useTz: true });
    t.timestamp('cancelled_at', { useTz: true });
    t.uuid('cancelled_by_user_id').references('id').inTable('users').onDelete('RESTRICT');
    t.text('cancelled_by_party');
    t.text('cancel_reason');
    t.timestamps(true, true);
  });
  await knex.raw(`
    ALTER TABLE appointments
      ADD COLUMN during tstzrange GENERATED ALWAYS AS (tstzrange(starts_at, ends_at, '[)')) STORED,
      ADD CONSTRAINT appointments_mode_valid CHECK (mode IN ('online', 'in_clinic')),
      ADD CONSTRAINT appointments_clinic_for_in_clinic CHECK (mode <> 'in_clinic' OR clinic_id IS NOT NULL),
      ADD CONSTRAINT appointments_status_valid CHECK (status IN
        ('pending_payment', 'confirmed', 'checked_in', 'in_consultation', 'completed', 'cancelled', 'no_show', 'expired')),
      ADD CONSTRAINT appointments_range_valid CHECK (ends_at > starts_at AND ends_at - starts_at <= interval '2 hours'),
      ADD CONSTRAINT appointments_hold_consistent CHECK (status <> 'pending_payment' OR hold_expires_at IS NOT NULL),
      ADD CONSTRAINT appointments_cancel_consistent CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
      ADD CONSTRAINT appointments_cancel_party_valid CHECK (cancelled_by_party IS NULL OR cancelled_by_party IN ('patient', 'doctor', 'clinic', 'system')),
      ADD CONSTRAINT appointments_cancel_reason_valid CHECK (cancel_reason IS NULL OR cancel_reason IN
        ('patient_request', 'doctor_unavailable', 'clinic_closed', 'rescheduled', 'duplicate', 'other')),
      ADD CONSTRAINT appointments_fee_valid CHECK (fee_paise >= 0),
      ADD CONSTRAINT appointments_idempotency_length CHECK (idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 8 AND 100),
      -- No double booking: a doctor and a patient each have at most one active appointment at a time.
      ADD CONSTRAINT appointments_no_doctor_overlap EXCLUDE USING gist (doctor_id WITH =, during WITH &&)
        WHERE (status IN ${ACTIVE_STATUSES}),
      ADD CONSTRAINT appointments_no_patient_overlap EXCLUDE USING gist (patient_id WITH =, during WITH &&)
        WHERE (status IN ${ACTIVE_STATUSES});
    CREATE UNIQUE INDEX appointments_idempotency_unique ON appointments (booked_by_user_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    CREATE INDEX appointments_patient_idx ON appointments (patient_id, starts_at DESC);
    CREATE INDEX appointments_doctor_idx ON appointments (doctor_id, starts_at);
    CREATE INDEX appointments_clinic_idx ON appointments (clinic_id, starts_at) WHERE clinic_id IS NOT NULL;
    CREATE INDEX appointments_holds_idx ON appointments (hold_expires_at) WHERE status = 'pending_payment';
  `);

  await knex.schema.createTable('appointment_intakes', (t) => {
    t.uuid('appointment_id')
      .primary()
      .references('id')
      .inTable('appointments')
      .onDelete('RESTRICT');
    t.text('reason').notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(`
    ALTER TABLE appointment_intakes
      ADD CONSTRAINT intakes_reason_length CHECK (char_length(reason) BETWEEN 3 AND 500);
  `);

  // ── Transactional outbox (ADR-0005) ─────────────────────────────
  await knex.schema.createTable('outbox_events', (t) => {
    t.uuid('id').primary();
    t.text('aggregate_type').notNullable();
    t.uuid('aggregate_id').notNullable();
    t.text('event_type').notNullable();
    t.jsonb('payload').notNullable().defaultTo('{}');
    t.text('request_id');
    t.timestamp('occurred_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('published_at', { useTz: true });
    t.integer('attempts').notNullable().defaultTo(0);
  });
  await knex.raw(`
    ALTER TABLE outbox_events
      ADD CONSTRAINT outbox_event_type_format CHECK (event_type ~ '^[a-z_]+\\.[a-z_]+$'),
      ADD CONSTRAINT outbox_payload_size CHECK (pg_column_size(payload) <= 4096);
    CREATE INDEX outbox_unpublished_idx ON outbox_events (occurred_at) WHERE published_at IS NULL;
  `);

  for (const table of ['availability_rules', 'appointments']) {
    await knex.raw(
      `CREATE TRIGGER ${table}_set_updated_at BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()`,
    );
  }

  // ── RLS (ADR-0017 model extended to appointments) ───────────────
  await knex.raw(`
    -- Active clinic administrator of a clinic (membership + clinic active).
    CREATE FUNCTION authz.is_clinic_manager(p_clinic uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
      SELECT p_clinic IS NOT NULL AND EXISTS (
        SELECT 1 FROM effective_role_grants g
         WHERE g.user_id = authz.current_user_id() AND g.clinic_id = p_clinic AND g.role = 'CLINIC_ADMIN')
    $fn$;

    CREATE FUNCTION authz.can_read_intake(p_appointment uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
      SELECT EXISTS (
        SELECT 1 FROM appointments a
         WHERE a.id = p_appointment
           AND (authz.is_patient_self(a.patient_id) OR authz.guardian_scope(a.patient_id) IS NOT NULL
                OR authz.is_doctor_user(a.doctor_id)))
    $fn$;

    CREATE FUNCTION authz.can_write_intake(p_appointment uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
      SELECT EXISTS (SELECT 1 FROM appointments a
                      WHERE a.id = p_appointment AND authz.can_manage_patient(a.patient_id))
    $fn$;

    -- Busy time of a doctor for slot computation: ranges only, no patient information.
    CREATE FUNCTION authz.doctor_busy_ranges(p_doctor uuid, p_from timestamptz, p_to timestamptz)
      RETURNS TABLE (starts_at timestamptz, ends_at timestamptz)
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
      SELECT a.starts_at, a.ends_at FROM appointments a
       WHERE authz.current_user_id() IS NOT NULL
         AND a.doctor_id = p_doctor AND a.during && tstzrange(p_from, p_to, '[)')
         AND a.status IN ${ACTIVE_STATUSES}
         AND NOT (a.status = 'pending_payment' AND a.hold_expires_at <= now())
    $fn$;

    -- Lazily expires stale payment holds for a doctor so they stop blocking slots.
    -- A system transition that touches only status/updated_at; returns the expired ids.
    CREATE FUNCTION authz.expire_stale_holds(p_doctor uuid) RETURNS SETOF uuid
      LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
      UPDATE appointments SET status = 'expired'
       WHERE doctor_id = p_doctor AND status = 'pending_payment' AND hold_expires_at <= now()
         AND authz.current_user_id() IS NOT NULL
      RETURNING id
    $fn$;

    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA authz FROM PUBLIC;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA authz TO "${app}";

    ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
    CREATE POLICY appointments_select ON appointments FOR SELECT USING (
      authz.is_patient_self(patient_id) OR authz.guardian_scope(patient_id) IS NOT NULL
      OR authz.is_doctor_user(doctor_id) OR authz.is_clinic_manager(clinic_id));
    CREATE POLICY appointments_insert ON appointments FOR INSERT WITH CHECK (
      booked_by_user_id = authz.current_user_id() AND authz.can_manage_patient(patient_id));
    CREATE POLICY appointments_update ON appointments FOR UPDATE
      USING (authz.can_manage_patient(patient_id) OR authz.is_doctor_user(doctor_id) OR authz.is_clinic_manager(clinic_id))
      WITH CHECK (authz.can_manage_patient(patient_id) OR authz.is_doctor_user(doctor_id) OR authz.is_clinic_manager(clinic_id));

    -- The reason for visit is clinical: patient side and the doctor only (never clinic staff).
    ALTER TABLE appointment_intakes ENABLE ROW LEVEL SECURITY;
    CREATE POLICY intakes_select ON appointment_intakes FOR SELECT USING (authz.can_read_intake(appointment_id));
    CREATE POLICY intakes_insert ON appointment_intakes FOR INSERT WITH CHECK (authz.can_write_intake(appointment_id));

    COMMENT ON TABLE outbox_events IS 'Transactional outbox: written with each domain change, relayed to BullMQ (ADR-0005). Payloads carry identifiers only.';
  `);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw(`
    DROP TABLE IF EXISTS outbox_events;
    DROP TABLE IF EXISTS appointment_intakes;
    DROP TABLE IF EXISTS appointments;
    DROP TABLE IF EXISTS availability_exceptions;
    DROP TABLE IF EXISTS availability_rules;
    DROP FUNCTION IF EXISTS authz.is_clinic_manager(uuid);
    DROP FUNCTION IF EXISTS authz.can_read_intake(uuid);
    DROP FUNCTION IF EXISTS authz.can_write_intake(uuid);
    DROP FUNCTION IF EXISTS authz.doctor_busy_ranges(uuid, timestamptz, timestamptz);
    DROP FUNCTION IF EXISTS authz.expire_stale_holds(uuid);
  `);
  const codes = NEW_PERMISSIONS.map(([code]) => code);
  await knex('role_permissions')
    .whereIn('permission_id', knex('permissions').select('id').whereIn('code', codes))
    .del();
  await knex('permissions').whereIn('code', codes).del();
}
