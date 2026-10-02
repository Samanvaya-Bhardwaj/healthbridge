/**
 * M4: payments, refunds, the append-only payment ledger, webhook event log, outbox relay
 * state, notification deliveries, appointment reminders and the dead-letter table
 * (ADR-0020).
 *
 * System context: webhooks and workers act without a user. They run in transactions that
 * set `app.system_purpose` (and never `app.user_id`); RLS policies grant each purpose
 * only the tables it needs:
 *   payments      → payment tables, ledger, appointment confirm/expire
 *   scheduler     → appointment hold expiry, reminders
 *   notifications → delivery log, reminders, minimal recipient lookup
 * A user transaction can never also be a system transaction (authz.system_purpose()
 * returns NULL whenever app.user_id is set).
 */

const NEW_PERMISSIONS = [
  ['payments:create', 'Pay for own or managed dependents’ appointments'],
  ['payments:read', 'Read own or managed dependents’ payment and refund details'],
  ['payments:refund', 'Issue refunds for appointments within relationship scope'],
  ['operations:manage', 'Inspect and retry failed background jobs (no patient data)'],
];
const NEW_ROLE_PERMISSIONS = {
  PATIENT: ['payments:create', 'payments:read'],
  DOCTOR: ['payments:refund'],
  CLINIC_ADMIN: ['payments:refund'],
  PLATFORM_ADMIN: ['operations:manage'],
};

const OLD_AUDIT_CATEGORIES = `('authentication', 'authorization', 'account', 'administration', 'data_access', 'system')`;
const NEW_AUDIT_CATEGORIES = `('authentication', 'authorization', 'account', 'administration', 'data_access', 'system', 'financial')`;

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
    ALTER TABLE audit.audit_logs DROP CONSTRAINT audit_category_valid;
    ALTER TABLE audit.audit_logs ADD CONSTRAINT audit_category_valid CHECK (category IN ${NEW_AUDIT_CATEGORIES});
  `);

  // ── Payments ────────────────────────────────────────────────────
  await knex.schema.createTable('payments', (t) => {
    t.uuid('id').primary();
    // One payment (provider order) per appointment; retries reuse the same order.
    t.uuid('appointment_id')
      .notNullable()
      .unique()
      .references('id')
      .inTable('appointments')
      .onDelete('RESTRICT');
    t.uuid('patient_id').notNullable().references('id').inTable('patients').onDelete('RESTRICT');
    t.uuid('payer_user_id').notNullable().references('id').inTable('users').onDelete('RESTRICT');
    t.text('provider').notNullable();
    t.text('provider_order_id');
    t.text('provider_payment_id');
    t.integer('amount_paise').notNullable();
    t.specificType('currency', 'char(3)').notNullable().defaultTo('INR');
    t.text('status').notNullable().defaultTo('pending');
    t.integer('refunded_paise').notNullable().defaultTo(0);
    t.text('failure_code');
    t.timestamp('authorized_at', { useTz: true });
    t.timestamp('paid_at', { useTz: true });
    t.timestamp('failed_at', { useTz: true });
    t.timestamp('cancelled_at', { useTz: true });
    t.timestamps(true, true);
  });
  await knex.raw(`
    ALTER TABLE payments
      ADD CONSTRAINT payments_provider_valid CHECK (provider IN ('fake', 'razorpay')),
      ADD CONSTRAINT payments_status_valid CHECK (status IN
        ('pending', 'authorized', 'paid', 'failed', 'cancelled', 'refunded', 'partially_refunded')),
      ADD CONSTRAINT payments_amount_valid CHECK (amount_paise > 0 AND amount_paise <= 10000000),
      ADD CONSTRAINT payments_refunded_valid CHECK (refunded_paise BETWEEN 0 AND amount_paise),
      ADD CONSTRAINT payments_paid_consistent CHECK (
        status NOT IN ('paid', 'refunded', 'partially_refunded') OR paid_at IS NOT NULL),
      ADD CONSTRAINT payments_refund_status_consistent CHECK (
        (status = 'refunded') = (refunded_paise = amount_paise AND paid_at IS NOT NULL)
        AND (status <> 'partially_refunded' OR refunded_paise > 0)),
      ADD CONSTRAINT payments_failure_code_format CHECK (failure_code IS NULL OR failure_code ~ '^[a-z0-9_]{1,64}$'),
      ADD CONSTRAINT payments_ref_length CHECK (
        coalesce(char_length(provider_order_id), 0) <= 64 AND coalesce(char_length(provider_payment_id), 0) <= 64);
    CREATE UNIQUE INDEX payments_provider_order_unique ON payments (provider, provider_order_id)
      WHERE provider_order_id IS NOT NULL;
    CREATE UNIQUE INDEX payments_provider_payment_unique ON payments (provider, provider_payment_id)
      WHERE provider_payment_id IS NOT NULL;
    CREATE INDEX payments_patient_idx ON payments (patient_id, created_at DESC);
  `);

  // Verified provider webhook events. The raw body is never stored (it can contain the
  // payer's contact details); only a digest and the provider-neutral references.
  await knex.schema.createTable('payment_events', (t) => {
    t.uuid('id').primary();
    t.text('provider').notNullable();
    t.text('provider_event_id').notNullable();
    t.text('event_type').notNullable();
    t.uuid('payment_id').references('id').inTable('payments').onDelete('RESTRICT');
    t.uuid('refund_id');
    t.text('provider_order_id');
    t.text('provider_payment_id');
    t.text('provider_refund_id');
    t.integer('amount_paise');
    t.text('payload_sha256').notNullable();
    t.text('processing_status').notNullable().defaultTo('received');
    t.text('outcome');
    t.timestamp('received_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('processed_at', { useTz: true });
    t.text('request_id');
    t.unique(['provider', 'provider_event_id']);
  });
  await knex.raw(`
    ALTER TABLE payment_events
      ADD CONSTRAINT payment_events_status_valid CHECK (processing_status IN ('received', 'processed', 'ignored', 'rejected')),
      ADD CONSTRAINT payment_events_outcome_format CHECK (outcome IS NULL OR outcome ~ '^[a-z_]{1,64}$'),
      ADD CONSTRAINT payment_events_type_format CHECK (event_type ~ '^[a-z_]+\\.[a-z_]+$'),
      ADD CONSTRAINT payment_events_id_length CHECK (char_length(provider_event_id) BETWEEN 1 AND 128),
      ADD CONSTRAINT payment_events_digest_format CHECK (payload_sha256 ~ '^[0-9a-f]{64}$');
    -- The provider's event-id header is not covered by the signature: an identical signed
    -- body replayed under a new event id is still a duplicate.
    CREATE UNIQUE INDEX payment_events_payload_unique ON payment_events (provider, payload_sha256);
    CREATE INDEX payment_events_payment_idx ON payment_events (payment_id, received_at);
  `);

  await knex.schema.createTable('payment_refunds', (t) => {
    t.uuid('id').primary();
    t.uuid('payment_id').notNullable().references('id').inTable('payments').onDelete('RESTRICT');
    t.uuid('appointment_id')
      .notNullable()
      .references('id')
      .inTable('appointments')
      .onDelete('RESTRICT');
    t.integer('amount_paise').notNullable();
    t.specificType('currency', 'char(3)').notNullable().defaultTo('INR');
    t.text('status').notNullable().defaultTo('pending');
    t.text('reason').notNullable();
    t.text('idempotency_key').notNullable().unique();
    t.text('requested_by_party').notNullable();
    t.uuid('requested_by_user_id').references('id').inTable('users').onDelete('RESTRICT');
    t.text('provider_refund_id');
    t.text('failure_code');
    t.integer('attempts').notNullable().defaultTo(0);
    t.timestamp('processed_at', { useTz: true });
    t.timestamps(true, true);
  });
  await knex.raw(`
    ALTER TABLE payment_refunds
      ADD CONSTRAINT refunds_amount_valid CHECK (amount_paise > 0),
      ADD CONSTRAINT refunds_status_valid CHECK (status IN ('pending', 'processing', 'processed', 'failed')),
      ADD CONSTRAINT refunds_reason_valid CHECK (reason IN
        ('appointment_cancelled', 'rescheduled', 'late_capture', 'goodwill', 'duplicate_payment', 'other')),
      ADD CONSTRAINT refunds_party_valid CHECK (requested_by_party IN ('patient', 'doctor', 'clinic', 'system')),
      ADD CONSTRAINT refunds_processed_consistent CHECK ((status = 'processed') = (processed_at IS NOT NULL)),
      ADD CONSTRAINT refunds_key_length CHECK (char_length(idempotency_key) BETWEEN 8 AND 120),
      ADD CONSTRAINT refunds_failure_code_format CHECK (failure_code IS NULL OR failure_code ~ '^[a-z0-9_]{1,64}$');
    CREATE UNIQUE INDEX refunds_provider_unique ON payment_refunds (provider_refund_id)
      WHERE provider_refund_id IS NOT NULL;
    CREATE INDEX refunds_payment_idx ON payment_refunds (payment_id);
    ALTER TABLE payment_events ADD CONSTRAINT payment_events_refund_fk
      FOREIGN KEY (refund_id) REFERENCES payment_refunds (id) ON DELETE RESTRICT;
  `);

  // Append-only financial record. Corrections are compensating entries (reverses_entry_id).
  await knex.schema.createTable('ledger_entries', (t) => {
    t.uuid('id').primary();
    t.text('entry_type').notNullable();
    t.text('direction').notNullable();
    t.integer('amount_paise').notNullable();
    t.specificType('currency', 'char(3)').notNullable().defaultTo('INR');
    t.uuid('payment_id').notNullable().references('id').inTable('payments').onDelete('RESTRICT');
    t.uuid('refund_id').references('id').inTable('payment_refunds').onDelete('RESTRICT');
    t.uuid('appointment_id')
      .notNullable()
      .references('id')
      .inTable('appointments')
      .onDelete('RESTRICT');
    t.text('provider').notNullable();
    t.text('provider_reference');
    t.uuid('payment_event_id').references('id').inTable('payment_events').onDelete('RESTRICT');
    t.uuid('reverses_entry_id').references('id').inTable('ledger_entries').onDelete('RESTRICT');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(`
    ALTER TABLE ledger_entries
      ADD CONSTRAINT ledger_type_valid CHECK (entry_type IN ('payment_captured', 'refund_processed', 'adjustment')),
      ADD CONSTRAINT ledger_direction_valid CHECK (direction IN ('credit', 'debit')),
      ADD CONSTRAINT ledger_direction_matches CHECK (
        (entry_type = 'payment_captured' AND direction = 'credit')
        OR (entry_type = 'refund_processed' AND direction = 'debit' AND refund_id IS NOT NULL)
        OR (entry_type = 'adjustment' AND reverses_entry_id IS NOT NULL)),
      ADD CONSTRAINT ledger_amount_valid CHECK (amount_paise > 0);
    -- Idempotency at the storage level: one capture per payment, one entry per refund.
    CREATE UNIQUE INDEX ledger_capture_unique ON ledger_entries (payment_id) WHERE entry_type = 'payment_captured';
    CREATE UNIQUE INDEX ledger_refund_unique ON ledger_entries (refund_id) WHERE entry_type = 'refund_processed';
    CREATE UNIQUE INDEX ledger_reversal_unique ON ledger_entries (reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;
    CREATE INDEX ledger_payment_idx ON ledger_entries (payment_id, created_at);

    CREATE FUNCTION public.reject_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      RAISE EXCEPTION 'ledger_entries is append-only; record a compensating entry instead'
        USING ERRCODE = 'insufficient_privilege';
    END
    $fn$;
    CREATE TRIGGER ledger_no_update_delete BEFORE UPDATE OR DELETE ON ledger_entries
      FOR EACH ROW EXECUTE FUNCTION public.reject_ledger_mutation();
    CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON ledger_entries
      FOR EACH STATEMENT EXECUTE FUNCTION public.reject_ledger_mutation();
    REVOKE UPDATE, DELETE, TRUNCATE ON ledger_entries FROM "${app}";
    REVOKE DELETE, TRUNCATE ON payments, payment_events, payment_refunds FROM "${app}";
  `);

  // ── Outbox relay state (ADR-0005, ADR-0020) ─────────────────────
  await knex.raw(`
    ALTER TABLE outbox_events
      ADD COLUMN status text NOT NULL DEFAULT 'pending',
      ADD COLUMN available_at timestamptz NOT NULL DEFAULT now(),
      ADD COLUMN last_error text,
      ADD CONSTRAINT outbox_status_valid CHECK (status IN ('pending', 'dispatched', 'failed')),
      ADD CONSTRAINT outbox_dispatched_consistent CHECK ((status = 'dispatched') = (published_at IS NOT NULL)),
      ADD CONSTRAINT outbox_last_error_length CHECK (last_error IS NULL OR char_length(last_error) <= 500);
    DROP INDEX outbox_unpublished_idx;
    CREATE INDEX outbox_pending_idx ON outbox_events (available_at, occurred_at) WHERE status = 'pending';
  `);

  // ── Notifications and reminders ─────────────────────────────────
  await knex.schema.createTable('notification_deliveries', (t) => {
    t.uuid('id').primary();
    t.text('dedupe_key').notNullable().unique();
    t.text('template').notNullable();
    t.text('channel').notNullable();
    t.uuid('recipient_user_id').references('id').inTable('users').onDelete('RESTRICT');
    t.uuid('appointment_id').references('id').inTable('appointments').onDelete('RESTRICT');
    t.uuid('source_event_id');
    t.text('status').notNullable().defaultTo('pending');
    t.text('skip_reason');
    t.integer('attempts').notNullable().defaultTo(0);
    t.text('last_error');
    t.timestamp('sent_at', { useTz: true });
    t.timestamps(true, true);
  });
  await knex.raw(`
    ALTER TABLE notification_deliveries
      ADD CONSTRAINT deliveries_channel_valid CHECK (channel IN ('email', 'sms')),
      ADD CONSTRAINT deliveries_status_valid CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
      ADD CONSTRAINT deliveries_template_valid CHECK (template IN (
        'appointment_booked', 'payment_required', 'payment_confirmed', 'payment_failed',
        'appointment_cancelled', 'appointment_rescheduled', 'appointment_expired',
        'appointment_reminder', 'payment_refunded')),
      ADD CONSTRAINT deliveries_sent_consistent CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
      ADD CONSTRAINT deliveries_error_length CHECK (last_error IS NULL OR char_length(last_error) <= 300);
    CREATE INDEX deliveries_appointment_idx ON notification_deliveries (appointment_id);
  `);

  await knex.schema.createTable('appointment_reminders', (t) => {
    t.uuid('id').primary();
    t.uuid('appointment_id')
      .notNullable()
      .references('id')
      .inTable('appointments')
      .onDelete('RESTRICT');
    t.integer('offset_minutes').notNullable();
    // The appointment start this reminder was planned for (the occurrence).
    t.timestamp('occurrence_starts_at', { useTz: true }).notNullable();
    t.timestamp('due_at', { useTz: true }).notNullable();
    t.text('status').notNullable().defaultTo('pending');
    t.text('skip_reason');
    t.integer('enqueue_count').notNullable().defaultTo(0);
    t.timestamp('enqueued_at', { useTz: true });
    t.timestamp('processed_at', { useTz: true });
    t.timestamps(true, true);
    t.unique(['appointment_id', 'offset_minutes', 'occurrence_starts_at']);
  });
  await knex.raw(`
    ALTER TABLE appointment_reminders
      ADD CONSTRAINT reminders_offset_valid CHECK (offset_minutes BETWEEN 5 AND 10080),
      ADD CONSTRAINT reminders_status_valid CHECK (status IN ('pending', 'sent', 'skipped', 'failed'));
    CREATE INDEX reminders_pending_idx ON appointment_reminders (due_at) WHERE status = 'pending';
    CREATE INDEX appointments_confirmed_start_idx ON appointments (starts_at) WHERE status = 'confirmed';
  `);

  // ── Dead letters (no patient data: identifiers and failure reasons only) ──
  await knex.schema.createTable('dead_letter_jobs', (t) => {
    t.uuid('id').primary();
    t.text('queue').notNullable();
    t.text('job_id').notNullable();
    t.text('job_name').notNullable();
    t.integer('attempts').notNullable();
    t.text('failure_reason').notNullable();
    t.jsonb('data').notNullable().defaultTo('{}');
    t.text('aggregate_type');
    t.uuid('aggregate_id');
    t.uuid('source_event_id');
    t.text('status').notNullable().defaultTo('open');
    t.timestamp('first_failed_at', { useTz: true });
    t.timestamp('failed_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('retried_at', { useTz: true });
    t.uuid('retried_by_user_id').references('id').inTable('users').onDelete('RESTRICT');
    t.unique(['queue', 'job_id']);
  });
  await knex.raw(`
    ALTER TABLE dead_letter_jobs
      ADD CONSTRAINT dead_letters_status_valid CHECK (status IN ('open', 'retried', 'resolved')),
      ADD CONSTRAINT dead_letters_reason_length CHECK (char_length(failure_reason) <= 500),
      ADD CONSTRAINT dead_letters_data_size CHECK (pg_column_size(data) <= 4096);
    CREATE INDEX dead_letters_open_idx ON dead_letter_jobs (failed_at DESC) WHERE status = 'open';
  `);

  for (const table of [
    'payments',
    'payment_refunds',
    'notification_deliveries',
    'appointment_reminders',
  ]) {
    await knex.raw(
      `CREATE TRIGGER ${table}_set_updated_at BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()`,
    );
  }

  // ── System context and RLS ──────────────────────────────────────
  await knex.raw(`
    -- Purpose of a system (non-user) transaction; NULL whenever a user actor is set, so a
    -- request transaction can never also carry system privileges.
    CREATE FUNCTION authz.system_purpose() RETURNS text
      LANGUAGE sql STABLE SET search_path = pg_catalog AS $fn$
      SELECT CASE
        WHEN authz.current_user_id() IS NULL
         AND current_setting('app.system_purpose', true) IN ('payments', 'scheduler', 'notifications')
        THEN current_setting('app.system_purpose', true)
      END
    $fn$;

    -- Patient side of a payment: the patient or a guardian of the patient.
    CREATE FUNCTION authz.can_view_payment(p_patient uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
      SELECT authz.is_patient_self(p_patient) OR authz.guardian_scope(p_patient) IS NOT NULL
    $fn$;

    -- Payment status only (no amounts, no provider references) for anyone who can see the
    -- appointment: lets doctors and clinic desks see "paid / awaiting payment".
    CREATE FUNCTION authz.appointment_payment_status(p_appointment uuid) RETURNS text
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
      SELECT p.status FROM payments p JOIN appointments a ON a.id = p.appointment_id
       WHERE p.appointment_id = p_appointment
         AND (authz.is_patient_self(a.patient_id) OR authz.guardian_scope(a.patient_id) IS NOT NULL
              OR authz.is_doctor_user(a.doctor_id) OR authz.is_clinic_manager(a.clinic_id))
    $fn$;

    -- Notification recipients for a patient: the patient's own account and active
    -- managing guardians. Contact details only; callable only by the notification worker.
    CREATE FUNCTION authz.notification_recipients(p_patient uuid)
      RETURNS TABLE (user_id uuid, email text, display_name text, phone_e164 text,
                     relationship text, patient_name text)
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
      SELECT u.id, u.email::text, coalesce(p.preferred_name, p.full_name), p.phone_e164, 'self',
             coalesce(p.preferred_name, p.full_name)
        FROM patients p JOIN users u ON u.id = p.user_id
       WHERE p.id = p_patient AND p.deleted_at IS NULL AND u.status = 'active' AND u.deleted_at IS NULL
         AND authz.system_purpose() = 'notifications'
      UNION ALL
      SELECT u.id, u.email::text, u.full_name, NULL, 'guardian', coalesce(p.preferred_name, p.full_name)
        FROM patient_guardianships g
        JOIN users u ON u.id = g.guardian_user_id
        JOIN patients p ON p.id = g.patient_id AND p.deleted_at IS NULL
       WHERE g.patient_id = p_patient AND g.status = 'active' AND g.access_scope = 'manage'
         AND u.status = 'active' AND u.deleted_at IS NULL
         AND authz.system_purpose() = 'notifications'
    $fn$;

    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA authz FROM PUBLIC;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA authz TO "${app}";

    -- Appointments: system workers read and transition (never insert or delete).
    CREATE POLICY appointments_system_select ON appointments FOR SELECT
      USING (authz.system_purpose() IN ('payments', 'scheduler', 'notifications'));
    CREATE POLICY appointments_system_update ON appointments FOR UPDATE
      USING (authz.system_purpose() IN ('payments', 'scheduler'))
      WITH CHECK (authz.system_purpose() IN ('payments', 'scheduler'));

    ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
    CREATE POLICY payments_select ON payments FOR SELECT
      USING (authz.system_purpose() = 'payments' OR authz.can_view_payment(patient_id));
    -- The patient side opens a payment (order creation); everything after that is driven
    -- by verified provider webhooks in the payments system context.
    CREATE POLICY payments_insert ON payments FOR INSERT WITH CHECK (
      status = 'pending' AND payer_user_id = authz.current_user_id()
      AND authz.can_manage_patient(patient_id));
    CREATE POLICY payments_system_update ON payments FOR UPDATE
      USING (authz.system_purpose() = 'payments') WITH CHECK (authz.system_purpose() = 'payments');

    ALTER TABLE payment_events ENABLE ROW LEVEL SECURITY;
    CREATE POLICY payment_events_system ON payment_events FOR ALL
      USING (authz.system_purpose() = 'payments') WITH CHECK (authz.system_purpose() = 'payments');

    ALTER TABLE payment_refunds ENABLE ROW LEVEL SECURITY;
    CREATE POLICY refunds_select ON payment_refunds FOR SELECT USING (
      authz.system_purpose() = 'payments'
      OR EXISTS (SELECT 1 FROM payments p WHERE p.id = payment_id AND authz.can_view_payment(p.patient_id)));
    CREATE POLICY refunds_system_insert ON payment_refunds FOR INSERT
      WITH CHECK (authz.system_purpose() = 'payments');
    CREATE POLICY refunds_system_update ON payment_refunds FOR UPDATE
      USING (authz.system_purpose() = 'payments') WITH CHECK (authz.system_purpose() = 'payments');

    ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY;
    CREATE POLICY ledger_system_select ON ledger_entries FOR SELECT USING (authz.system_purpose() = 'payments');
    CREATE POLICY ledger_system_insert ON ledger_entries FOR INSERT WITH CHECK (authz.system_purpose() = 'payments');

    ALTER TABLE notification_deliveries ENABLE ROW LEVEL SECURITY;
    CREATE POLICY deliveries_system ON notification_deliveries FOR ALL
      USING (authz.system_purpose() = 'notifications') WITH CHECK (authz.system_purpose() = 'notifications');

    ALTER TABLE appointment_reminders ENABLE ROW LEVEL SECURITY;
    CREATE POLICY reminders_system ON appointment_reminders FOR ALL
      USING (authz.system_purpose() IN ('scheduler', 'notifications'))
      WITH CHECK (authz.system_purpose() IN ('scheduler', 'notifications'));

    COMMENT ON TABLE ledger_entries IS 'Append-only payment ledger (ADR-0020). Corrections are compensating entries.';
    COMMENT ON TABLE payment_events IS 'Verified provider webhook events; UNIQUE (provider, provider_event_id) makes delivery replay-safe.';
    COMMENT ON TABLE dead_letter_jobs IS 'Jobs that exhausted their retries. Identifiers and failure reasons only.';
  `);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw(`
    DROP POLICY IF EXISTS appointments_system_select ON appointments;
    DROP POLICY IF EXISTS appointments_system_update ON appointments;
    DROP TABLE IF EXISTS dead_letter_jobs;
    DROP TABLE IF EXISTS appointment_reminders;
    DROP INDEX IF EXISTS appointments_confirmed_start_idx;
    DROP TABLE IF EXISTS notification_deliveries;
    DROP TABLE IF EXISTS ledger_entries;
    ALTER TABLE payment_events DROP CONSTRAINT IF EXISTS payment_events_refund_fk;
    DROP TABLE IF EXISTS payment_refunds;
    DROP TABLE IF EXISTS payment_events;
    DROP TABLE IF EXISTS payments;
    DROP FUNCTION IF EXISTS public.reject_ledger_mutation();
    DROP FUNCTION IF EXISTS authz.notification_recipients(uuid);
    DROP FUNCTION IF EXISTS authz.appointment_payment_status(uuid);
    DROP FUNCTION IF EXISTS authz.can_view_payment(uuid);
    DROP FUNCTION IF EXISTS authz.system_purpose();

    DROP INDEX IF EXISTS outbox_pending_idx;
    ALTER TABLE outbox_events
      DROP CONSTRAINT IF EXISTS outbox_status_valid,
      DROP CONSTRAINT IF EXISTS outbox_dispatched_consistent,
      DROP CONSTRAINT IF EXISTS outbox_last_error_length,
      DROP COLUMN IF EXISTS status,
      DROP COLUMN IF EXISTS available_at,
      DROP COLUMN IF EXISTS last_error;
    CREATE INDEX outbox_unpublished_idx ON outbox_events (occurred_at) WHERE published_at IS NULL;

    ALTER TABLE audit.audit_logs DROP CONSTRAINT audit_category_valid;
  `);
  // Audit rows are append-only: financial rows written while M4 was applied keep their
  // category, so the restored constraint is NOT VALID for existing rows.
  await knex.raw(
    `ALTER TABLE audit.audit_logs ADD CONSTRAINT audit_category_valid CHECK (category IN ${OLD_AUDIT_CATEGORIES}) NOT VALID`,
  );
  const codes = NEW_PERMISSIONS.map(([code]) => code);
  await knex('role_permissions')
    .whereIn('permission_id', knex('permissions').select('id').whereIn('code', codes))
    .del();
  await knex('permissions').whereIn('code', codes).del();
}
