/**
 * M1: identity, RBAC, sessions, and the append-only audit log.
 *
 * Roles/permissions are seeded from a literal snapshot (migrations must not import
 * application code, so they stay reproducible). `shared/src/auth/permissions.js` is the
 * code-side contract; a test and a startup check fail if the two drift apart. Changes to
 * the mapping are made by new migrations.
 */

const ROLES = [
  ['PATIENT', 'Patient', 'Receives care; manages own records and consent.'],
  ['DOCTOR', 'Doctor', 'Registered medical practitioner providing consultations.'],
  ['CLINIC_ADMIN', 'Clinic administrator', 'Manages a clinic’s doctors, slots and staff.'],
  ['PLATFORM_ADMIN', 'Platform administrator', 'Operates the platform; no clinical access.'],
  ['SUPPORT', 'Support', 'Helps users with accounts and appointments; no clinical access.'],
];

const PERMISSIONS = [
  ['account:read', 'Read own account profile'],
  ['account:update', 'Update own account profile and password'],
  ['sessions:read', 'List own active sessions'],
  ['sessions:revoke', 'Revoke own sessions'],
  ['appointments:create', 'Create appointments'],
  ['appointments:read', 'Read appointments within relationship scope'],
  ['medical_records:read', 'Read medical records within relationship and consent scope'],
  ['medical_records:write', 'Add medical records within relationship and consent scope'],
  ['prescriptions:read', 'Read prescriptions within relationship and consent scope'],
  ['prescriptions:sign', 'Create and sign prescriptions for own consultations'],
  ['clinic:manage', 'Manage own clinic (doctors, slots, staff)'],
  ['users:read', 'Read user accounts (administration/support)'],
  ['users:update', 'Change user account status'],
  ['admin:users', 'Grant and revoke user roles'],
  ['admin:doctors', 'Review doctor credential verification'],
  ['admin:sessions', 'Revoke any user’s sessions'],
  ['audit:read', 'Read audit logs'],
];

const OWN = ['account:read', 'account:update', 'sessions:read', 'sessions:revoke'];
const ROLE_PERMISSIONS = {
  PATIENT: [
    ...OWN,
    'appointments:create',
    'appointments:read',
    'medical_records:read',
    'medical_records:write',
    'prescriptions:read',
  ],
  DOCTOR: [
    ...OWN,
    'appointments:read',
    'medical_records:read',
    'medical_records:write',
    'prescriptions:read',
    'prescriptions:sign',
  ],
  CLINIC_ADMIN: [...OWN, 'appointments:create', 'appointments:read', 'clinic:manage'],
  PLATFORM_ADMIN: [
    ...OWN,
    'users:read',
    'users:update',
    'admin:users',
    'admin:doctors',
    'admin:sessions',
    'audit:read',
  ],
  SUPPORT: [...OWN, 'users:read', 'appointments:read'],
};

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  // ── RBAC catalog ─────────────────────────────────────────────
  await knex.schema.createTable('roles', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('code').notNullable().unique();
    t.text('name').notNullable();
    t.text('description').notNullable();
    t.timestamps(true, true);
  });
  await knex.raw(
    `ALTER TABLE roles ADD CONSTRAINT roles_code_format CHECK (code ~ '^[A-Z][A-Z_]{1,39}$')`,
  );

  await knex.schema.createTable('permissions', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('code').notNullable().unique();
    t.text('description').notNullable();
    t.timestamps(true, true);
  });
  await knex.raw(
    `ALTER TABLE permissions ADD CONSTRAINT permissions_code_format CHECK (code ~ '^[a-z_]+:[a-z_]+$')`,
  );

  await knex.schema.createTable('role_permissions', (t) => {
    t.uuid('role_id').notNullable().references('id').inTable('roles').onDelete('CASCADE');
    t.uuid('permission_id')
      .notNullable()
      .references('id')
      .inTable('permissions')
      .onDelete('CASCADE');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.primary(['role_id', 'permission_id']);
    t.index(['permission_id']);
  });

  // ── Users ────────────────────────────────────────────────────
  await knex.schema.createTable('users', (t) => {
    t.uuid('id').primary();
    t.specificType('email', 'citext').notNullable();
    t.text('full_name').notNullable();
    t.text('password_hash').notNullable();
    t.timestamp('password_changed_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.text('status').notNullable().defaultTo('active');
    t.integer('failed_login_attempts').notNullable().defaultTo(0);
    t.timestamp('locked_until', { useTz: true });
    t.timestamp('last_login_at', { useTz: true });
    t.timestamp('email_verified_at', { useTz: true });
    t.timestamp('terms_accepted_at', { useTz: true });
    t.text('terms_version');
    t.boolean('is_demo').notNullable().defaultTo(false);
    t.timestamps(true, true);
    t.timestamp('deleted_at', { useTz: true });
  });
  await knex.raw(`
    ALTER TABLE users
      ADD CONSTRAINT users_status_valid CHECK (status IN ('active', 'disabled')),
      ADD CONSTRAINT users_email_format CHECK (char_length(email) <= 254 AND email ~ '^[^@\\s]+@[^@\\s]+$'),
      ADD CONSTRAINT users_full_name_length CHECK (char_length(full_name) BETWEEN 1 AND 120),
      ADD CONSTRAINT users_password_hash_format CHECK (password_hash LIKE '$argon2id$%'),
      ADD CONSTRAINT users_failed_attempts_nonnegative CHECK (failed_login_attempts >= 0);
    -- One live account per email; soft-deleted accounts do not block re-registration.
    CREATE UNIQUE INDEX users_email_live_unique ON users (email) WHERE deleted_at IS NULL;
    CREATE INDEX users_created_at_idx ON users (created_at DESC, id DESC);
  `);

  await knex.schema.createTable('user_roles', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.uuid('role_id').notNullable().references('id').inTable('roles').onDelete('RESTRICT');
    // Scope for clinic roles. FK to clinics is added when clinics exist (M2).
    t.uuid('clinic_id');
    t.uuid('granted_by').references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['role_id']);
  });
  await knex.raw(`
    CREATE UNIQUE INDEX user_roles_unique_assignment
      ON user_roles (user_id, role_id, COALESCE(clinic_id, '00000000-0000-0000-0000-000000000000'::uuid));
  `);

  // ── Sessions (one row per login; refresh token rotates within the row) ──
  await knex.schema.createTable('sessions', (t) => {
    t.uuid('id').primary();
    t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    // SHA-256 of high-entropy secrets; raw tokens are never stored.
    t.text('refresh_token_hash').notNullable().unique();
    t.text('previous_refresh_token_hash');
    t.timestamp('rotated_at', { useTz: true });
    t.integer('rotation_count').notNullable().defaultTo(0);
    t.text('csrf_token_hash').notNullable();
    t.timestamp('idle_expires_at', { useTz: true }).notNullable();
    t.timestamp('absolute_expires_at', { useTz: true }).notNullable();
    t.timestamp('last_used_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('revoked_at', { useTz: true });
    t.text('revoked_reason');
    t.specificType('ip', 'inet');
    t.text('user_agent');
    t.timestamps(true, true);
  });
  await knex.raw(`
    ALTER TABLE sessions
      ADD CONSTRAINT sessions_hash_format CHECK (refresh_token_hash ~ '^[0-9a-f]{64}$' AND csrf_token_hash ~ '^[0-9a-f]{64}$'),
      ADD CONSTRAINT sessions_expiry_order CHECK (idle_expires_at <= absolute_expires_at AND absolute_expires_at > created_at),
      ADD CONSTRAINT sessions_user_agent_length CHECK (user_agent IS NULL OR char_length(user_agent) <= 512),
      ADD CONSTRAINT sessions_revocation_consistent CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)),
      ADD CONSTRAINT sessions_revoked_reason_valid CHECK (revoked_reason IS NULL OR revoked_reason IN (
        'logout', 'user_revoked', 'admin_revoked', 'password_changed', 'account_disabled',
        'refresh_token_reuse', 'expired'));
    CREATE INDEX sessions_user_active_idx ON sessions (user_id, created_at DESC) WHERE revoked_at IS NULL;
  `);

  for (const table of ['roles', 'permissions', 'users', 'sessions']) {
    await knex.raw(
      `CREATE TRIGGER ${table}_set_updated_at BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()`,
    );
  }

  // ── Audit log (append-only) ──────────────────────────────────
  await knex.schema.withSchema('audit').createTable('audit_logs', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.timestamp('occurred_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.text('category').notNullable();
    t.text('action').notNullable();
    t.text('outcome').notNullable();
    t.text('actor_type').notNullable();
    t.uuid('actor_user_id'); // no FK: audit rows must outlive and never block user changes
    t.specificType('actor_roles', 'text[]').notNullable().defaultTo('{}');
    t.uuid('session_id');
    t.text('resource_type');
    t.text('resource_id');
    t.uuid('patient_id'); // populated for patient-data access decisions (M2+)
    t.text('reason');
    t.text('request_id');
    t.specificType('ip', 'inet');
    t.text('user_agent');
    t.jsonb('metadata').notNullable().defaultTo('{}');
  });
  await knex.raw(`
    ALTER TABLE audit.audit_logs
      ADD CONSTRAINT audit_category_valid CHECK (category IN
        ('authentication', 'authorization', 'account', 'administration', 'data_access', 'system')),
      ADD CONSTRAINT audit_outcome_valid CHECK (outcome IN ('success', 'failure', 'denied')),
      ADD CONSTRAINT audit_actor_type_valid CHECK (actor_type IN ('user', 'anonymous', 'system')),
      ADD CONSTRAINT audit_action_format CHECK (action ~ '^[a-z_]+(\\.[a-z_]+)+$|^[a-z_]+:[a-z_]+$'),
      ADD CONSTRAINT audit_user_agent_length CHECK (user_agent IS NULL OR char_length(user_agent) <= 512),
      ADD CONSTRAINT audit_metadata_size CHECK (pg_column_size(metadata) <= 8192);

    CREATE INDEX audit_logs_occurred_brin ON audit.audit_logs USING brin (occurred_at);
    CREATE INDEX audit_logs_actor_idx ON audit.audit_logs (actor_user_id, occurred_at DESC);
    CREATE INDEX audit_logs_action_idx ON audit.audit_logs (action, occurred_at DESC);
    CREATE INDEX audit_logs_resource_idx ON audit.audit_logs (resource_type, resource_id);
    CREATE INDEX audit_logs_patient_idx ON audit.audit_logs (patient_id, occurred_at DESC) WHERE patient_id IS NOT NULL;
    CREATE INDEX audit_logs_request_idx ON audit.audit_logs (request_id);

    -- Defence in depth beyond privileges (the app role has SELECT/INSERT only):
    -- reject UPDATE/DELETE/TRUNCATE even from roles that hold those privileges.
    CREATE FUNCTION audit.reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      RAISE EXCEPTION 'audit.audit_logs is append-only' USING ERRCODE = 'insufficient_privilege';
    END
    $fn$;
    CREATE TRIGGER audit_logs_no_update_delete BEFORE UPDATE OR DELETE ON audit.audit_logs
      FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();
    CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit.audit_logs
      FOR EACH STATEMENT EXECUTE FUNCTION audit.reject_mutation();

    COMMENT ON TABLE audit.audit_logs IS 'Append-only security audit trail (ADR-0006, ADR-0016).';
  `);

  // ── Seed RBAC snapshot ───────────────────────────────────────
  await knex('roles').insert(
    ROLES.map(([code, name, description]) => ({ code, name, description })),
  );
  await knex('permissions').insert(
    PERMISSIONS.map(([code, description]) => ({ code, description })),
  );
  const roleIds = Object.fromEntries(
    (await knex('roles').select('id', 'code')).map((r) => [r.code, r.id]),
  );
  const permIds = Object.fromEntries(
    (await knex('permissions').select('id', 'code')).map((p) => [p.code, p.id]),
  );
  const rows = Object.entries(ROLE_PERMISSIONS).flatMap(([role, perms]) =>
    perms.map((perm) => ({ role_id: roleIds[role], permission_id: permIds[perm] })),
  );
  await knex('role_permissions').insert(rows);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw(`
    DROP TABLE IF EXISTS audit.audit_logs;
    DROP FUNCTION IF EXISTS audit.reject_mutation();
  `);
  await knex.schema.dropTableIfExists('sessions');
  await knex.schema.dropTableIfExists('user_roles');
  await knex.schema.dropTableIfExists('users');
  await knex.schema.dropTableIfExists('role_permissions');
  await knex.schema.dropTableIfExists('permissions');
  await knex.schema.dropTableIfExists('roles');
}
