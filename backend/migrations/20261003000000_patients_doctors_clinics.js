/**
 * M2: patients, dependents (guardianships), doctors, doctor verification, clinics,
 * clinic memberships, care relationships, clinic-scoped roles, and row-level security.
 *
 * Patient-scoped tables (patients, patient_guardianships, care_relationships) have RLS
 * enabled. Every query against them must run in a transaction that sets
 * `app.user_id` (see backend/src/core/db/actorContext.js); without it no rows are
 * visible or writable. Relationship predicates live in SECURITY DEFINER functions in the
 * `authz` schema so policies do not recurse into each other's RLS (ADR-0017).
 */

const NEW_PERMISSIONS = [
  ['patients:read', 'Read patient profiles within relationship and consent scope'],
  ['patients:write', 'Create and update patient profiles for self or managed dependents'],
  ['dependents:manage', 'Create and manage dependent family members'],
  ['care_relationships:read', 'Read own care relationships (My Doctors / My Patients)'],
  ['care_relationships:manage', 'Request, accept, pause and end care relationships'],
  ['doctor_profile:manage', 'Create and update own doctor profile and request verification'],
  ['doctors:read', 'Browse the directory of verified doctors'],
  ['clinics:read', 'Read clinic information'],
  ['admin:clinics', 'Create clinics and appoint clinic administrators'],
];

const NEW_ROLE_PERMISSIONS = {
  PATIENT: [
    'patients:read',
    'patients:write',
    'dependents:manage',
    'care_relationships:read',
    'care_relationships:manage',
    'doctor_profile:manage',
    'doctors:read',
  ],
  DOCTOR: [
    'patients:read',
    'care_relationships:read',
    'care_relationships:manage',
    'doctor_profile:manage',
    'doctors:read',
    'clinics:read',
  ],
  CLINIC_ADMIN: ['clinics:read', 'doctors:read'],
  PLATFORM_ADMIN: ['admin:clinics', 'clinics:read', 'doctors:read'],
  SUPPORT: ['doctors:read', 'clinics:read'],
};

const ADDRESS_COLUMNS = (t) => {
  t.text('address_line');
  t.text('city');
  t.text('state');
  t.text('postal_code');
  t.specificType('country_code', 'char(2)').notNullable().defaultTo('IN');
};

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  const app = process.env.DB_APP_USER ?? 'hb_app';
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(app)) throw new Error(`Invalid role name: ${app}`);

  // ── RBAC: role scope and new permissions ─────────────────────────
  await knex.schema.alterTable('roles', (t) => {
    t.text('scope').notNullable().defaultTo('global');
  });
  await knex.raw(`
    ALTER TABLE roles ADD CONSTRAINT roles_scope_valid CHECK (scope IN ('global', 'clinic'));
    UPDATE roles SET scope = 'clinic' WHERE code = 'CLINIC_ADMIN';
  `);
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

  // ── Clinics ──────────────────────────────────────────────────────
  await knex.schema.createTable('clinics', (t) => {
    t.uuid('id').primary();
    t.text('name').notNullable();
    t.text('registration_number');
    t.text('phone_e164');
    t.specificType('email', 'citext');
    ADDRESS_COLUMNS(t);
    t.text('status').notNullable().defaultTo('active');
    t.boolean('is_demo').notNullable().defaultTo(false);
    t.uuid('created_by_user_id')
      .notNullable()
      .references('id')
      .inTable('users')
      .onDelete('RESTRICT');
    t.timestamps(true, true);
    t.timestamp('deleted_at', { useTz: true });
  });
  await knex.raw(`
    ALTER TABLE clinics
      ADD CONSTRAINT clinics_status_valid CHECK (status IN ('active', 'inactive')),
      ADD CONSTRAINT clinics_name_length CHECK (char_length(name) BETWEEN 2 AND 150),
      ADD CONSTRAINT clinics_phone_format CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\\+[1-9][0-9]{6,14}$');
    CREATE UNIQUE INDEX clinics_registration_unique ON clinics (registration_number)
      WHERE registration_number IS NOT NULL AND deleted_at IS NULL;
    CREATE INDEX clinics_created_idx ON clinics (created_at DESC, id DESC);
  `);

  // ── Clinic-scoped roles: complete the deferred FK and enforce scope ──
  await knex.raw(`
    -- Unscoped grants of clinic-scoped roles (possible before M2) are invalid now.
    DELETE FROM user_roles ur USING roles r
     WHERE r.id = ur.role_id AND r.scope = 'clinic' AND ur.clinic_id IS NULL;

    ALTER TABLE user_roles
      ADD CONSTRAINT user_roles_clinic_fk FOREIGN KEY (clinic_id) REFERENCES clinics (id) ON DELETE RESTRICT;
    CREATE INDEX user_roles_clinic_idx ON user_roles (clinic_id) WHERE clinic_id IS NOT NULL;

    CREATE FUNCTION public.user_roles_enforce_scope() RETURNS trigger LANGUAGE plpgsql AS $fn$
    DECLARE role_scope text;
    BEGIN
      SELECT scope INTO role_scope FROM roles WHERE id = NEW.role_id;
      IF role_scope = 'clinic' AND NEW.clinic_id IS NULL THEN
        RAISE EXCEPTION 'clinic-scoped role requires clinic_id' USING ERRCODE = 'check_violation';
      ELSIF role_scope = 'global' AND NEW.clinic_id IS NOT NULL THEN
        RAISE EXCEPTION 'global role must not have clinic_id' USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END
    $fn$;
    CREATE TRIGGER user_roles_scope BEFORE INSERT OR UPDATE ON user_roles
      FOR EACH ROW EXECUTE FUNCTION public.user_roles_enforce_scope();
  `);

  await knex.schema.createTable('clinic_memberships', (t) => {
    t.uuid('id').primary();
    t.uuid('clinic_id').notNullable().references('id').inTable('clinics').onDelete('RESTRICT');
    t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('RESTRICT');
    t.text('member_role').notNullable();
    t.text('status').notNullable();
    t.uuid('invited_by_user_id').references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('joined_at', { useTz: true });
    t.timestamp('ended_at', { useTz: true });
    t.text('end_reason');
    t.timestamps(true, true);
  });
  await knex.raw(`
    ALTER TABLE clinic_memberships
      ADD CONSTRAINT clinic_memberships_role_valid CHECK (member_role IN ('CLINIC_ADMIN', 'DOCTOR')),
      ADD CONSTRAINT clinic_memberships_status_valid CHECK (status IN ('invited', 'active', 'suspended', 'ended')),
      ADD CONSTRAINT clinic_memberships_end_consistent CHECK ((status = 'ended') = (ended_at IS NOT NULL)),
      ADD CONSTRAINT clinic_memberships_joined_consistent CHECK (status <> 'active' OR joined_at IS NOT NULL);
    CREATE UNIQUE INDEX clinic_memberships_open_unique ON clinic_memberships (clinic_id, user_id, member_role)
      WHERE status IN ('invited', 'active', 'suspended');
    CREATE INDEX clinic_memberships_user_idx ON clinic_memberships (user_id) WHERE status <> 'ended';

    -- Roles that are in force: global grants, plus clinic grants backed by an active
    -- membership in an active clinic. Principal loading reads only this view.
    CREATE VIEW effective_role_grants AS
      SELECT ur.user_id, r.code AS role, ur.clinic_id
        FROM user_roles ur
        JOIN roles r ON r.id = ur.role_id
       WHERE ur.clinic_id IS NULL
          OR EXISTS (
               SELECT 1 FROM clinic_memberships m
                 JOIN clinics c ON c.id = m.clinic_id
                WHERE m.clinic_id = ur.clinic_id AND m.user_id = ur.user_id
                  AND m.member_role = r.code AND m.status = 'active'
                  AND c.status = 'active' AND c.deleted_at IS NULL);
  `);

  // ── Patients ─────────────────────────────────────────────────────
  await knex.schema.createTable('patients', (t) => {
    t.uuid('id').primary();
    // Null for dependents without their own login (e.g. a child or an elderly parent).
    t.uuid('user_id').unique().references('id').inTable('users').onDelete('RESTRICT');
    t.text('full_name').notNullable();
    t.text('preferred_name');
    t.date('date_of_birth').notNullable();
    t.text('sex');
    t.text('phone_e164');
    ADDRESS_COLUMNS(t);
    t.text('preferred_language');
    t.text('emergency_contact_name');
    t.text('emergency_contact_phone');
    t.text('emergency_contact_relationship');
    t.text('status').notNullable().defaultTo('active');
    t.boolean('is_demo').notNullable().defaultTo(false);
    t.uuid('created_by_user_id')
      .notNullable()
      .references('id')
      .inTable('users')
      .onDelete('RESTRICT');
    t.timestamps(true, true);
    t.timestamp('deleted_at', { useTz: true });
  });
  await knex.raw(`
    ALTER TABLE patients
      ADD CONSTRAINT patients_status_valid CHECK (status IN ('active', 'archived')),
      ADD CONSTRAINT patients_full_name_length CHECK (char_length(full_name) BETWEEN 1 AND 120),
      ADD CONSTRAINT patients_dob_range CHECK (date_of_birth >= DATE '1900-01-01'),
      ADD CONSTRAINT patients_sex_valid CHECK (sex IS NULL OR sex IN ('female', 'male', 'intersex', 'unspecified')),
      ADD CONSTRAINT patients_phone_format CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\\+[1-9][0-9]{6,14}$'),
      ADD CONSTRAINT patients_emergency_phone_format CHECK (emergency_contact_phone IS NULL OR emergency_contact_phone ~ '^\\+[1-9][0-9]{6,14}$'),
      ADD CONSTRAINT patients_emergency_complete CHECK (
        (emergency_contact_name IS NULL) = (emergency_contact_phone IS NULL)),
      -- A self-managed profile is created by its own user.
      ADD CONSTRAINT patients_self_created CHECK (user_id IS NULL OR user_id = created_by_user_id);
    CREATE INDEX patients_created_by_idx ON patients (created_by_user_id);

    -- The owning account of a profile can never be reassigned.
    CREATE FUNCTION public.patients_lock_owner() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF OLD.user_id IS DISTINCT FROM NEW.user_id OR OLD.created_by_user_id IS DISTINCT FROM NEW.created_by_user_id THEN
        RAISE EXCEPTION 'patient ownership cannot change' USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END
    $fn$;
    CREATE TRIGGER patients_owner_immutable BEFORE UPDATE ON patients
      FOR EACH ROW EXECUTE FUNCTION public.patients_lock_owner();
  `);

  // ── Guardianships (actor → relationship → dependent) ─────────────
  await knex.schema.createTable('patient_guardianships', (t) => {
    t.uuid('id').primary();
    t.uuid('patient_id').notNullable().references('id').inTable('patients').onDelete('RESTRICT');
    t.uuid('guardian_user_id').notNullable().references('id').inTable('users').onDelete('RESTRICT');
    t.text('relationship_type').notNullable();
    t.text('access_scope').notNullable();
    t.text('basis').notNullable();
    t.text('status').notNullable();
    t.timestamp('started_at', { useTz: true });
    t.timestamp('ended_at', { useTz: true });
    t.text('end_reason');
    t.uuid('created_by_user_id')
      .notNullable()
      .references('id')
      .inTable('users')
      .onDelete('RESTRICT');
    t.timestamps(true, true);
  });
  await knex.raw(`
    ALTER TABLE patient_guardianships
      ADD CONSTRAINT guardianships_relationship_valid CHECK (relationship_type IN
        ('parent', 'child', 'spouse', 'sibling', 'grandparent', 'grandchild', 'legal_guardian', 'caregiver', 'other_family')),
      ADD CONSTRAINT guardianships_scope_valid CHECK (access_scope IN ('manage', 'view')),
      ADD CONSTRAINT guardianships_basis_valid CHECK (basis IN ('created_dependent', 'patient_delegation', 'legal_authority')),
      ADD CONSTRAINT guardianships_status_valid CHECK (status IN ('pending', 'active', 'ended')),
      ADD CONSTRAINT guardianships_end_consistent CHECK ((status = 'ended') = (ended_at IS NOT NULL)),
      ADD CONSTRAINT guardianships_start_consistent CHECK (status <> 'active' OR started_at IS NOT NULL),
      ADD CONSTRAINT guardianships_end_reason_valid CHECK (end_reason IS NULL OR end_reason IN
        ('guardian_ended', 'patient_ended', 'admin_ended'));
    CREATE UNIQUE INDEX guardianships_open_unique ON patient_guardianships (patient_id, guardian_user_id)
      WHERE status IN ('pending', 'active');
    CREATE INDEX guardianships_guardian_idx ON patient_guardianships (guardian_user_id) WHERE status = 'active';
  `);

  // ── Doctors and verification ─────────────────────────────────────
  await knex.schema.createTable('doctors', (t) => {
    t.uuid('id').primary();
    t.uuid('user_id').notNullable().unique().references('id').inTable('users').onDelete('RESTRICT');
    t.text('professional_name').notNullable();
    t.text('registration_number').notNullable();
    t.text('registration_council').notNullable();
    t.smallint('registration_year').notNullable();
    t.text('primary_specialization').notNullable();
    t.specificType('additional_specializations', 'text[]').notNullable().defaultTo('{}');
    t.jsonb('qualifications').notNullable().defaultTo('[]');
    t.smallint('years_of_experience').notNullable().defaultTo(0);
    t.specificType('languages', 'text[]').notNullable().defaultTo('{}');
    t.text('bio');
    t.text('profile_status').notNullable().defaultTo('draft');
    t.text('verification_status').notNullable().defaultTo('unverified');
    t.timestamp('verified_at', { useTz: true });
    t.boolean('is_demo').notNullable().defaultTo(false);
    t.timestamps(true, true);
    t.timestamp('deleted_at', { useTz: true });
  });
  await knex.raw(`
    ALTER TABLE doctors
      ADD CONSTRAINT doctors_profile_status_valid CHECK (profile_status IN ('draft', 'active', 'suspended')),
      ADD CONSTRAINT doctors_verification_status_valid CHECK (verification_status IN
        ('unverified', 'pending', 'under_review', 'verified', 'rejected', 'suspended')),
      -- Only a verified doctor can have a public, active profile.
      ADD CONSTRAINT doctors_active_requires_verified CHECK (profile_status <> 'active' OR verification_status = 'verified'),
      ADD CONSTRAINT doctors_verified_at_consistent CHECK (verification_status <> 'verified' OR verified_at IS NOT NULL),
      ADD CONSTRAINT doctors_name_length CHECK (char_length(professional_name) BETWEEN 2 AND 120),
      ADD CONSTRAINT doctors_registration_year CHECK (registration_year BETWEEN 1950 AND 2100),
      ADD CONSTRAINT doctors_experience_range CHECK (years_of_experience BETWEEN 0 AND 70),
      ADD CONSTRAINT doctors_qualifications_array CHECK (jsonb_typeof(qualifications) = 'array'),
      ADD CONSTRAINT doctors_bio_length CHECK (bio IS NULL OR char_length(bio) <= 1000);
    CREATE UNIQUE INDEX doctors_registration_unique ON doctors (registration_council, registration_number)
      WHERE deleted_at IS NULL;
    CREATE INDEX doctors_directory_idx ON doctors (primary_specialization)
      WHERE profile_status = 'active' AND verification_status = 'verified' AND deleted_at IS NULL;
  `);

  await knex.schema.createTable('doctor_verifications', (t) => {
    t.uuid('id').primary();
    t.uuid('doctor_id').notNullable().references('id').inTable('doctors').onDelete('RESTRICT');
    t.text('status').notNullable();
    // Snapshot of what was submitted for verification.
    t.text('registration_number').notNullable();
    t.text('registration_council').notNullable();
    t.smallint('registration_year').notNullable();
    t.uuid('submitted_by_user_id').references('id').inTable('users').onDelete('RESTRICT');
    t.timestamp('submitted_at', { useTz: true }).notNullable();
    t.uuid('reviewer_user_id').references('id').inTable('users').onDelete('RESTRICT');
    t.timestamp('review_started_at', { useTz: true });
    t.uuid('decided_by_user_id').references('id').inTable('users').onDelete('RESTRICT');
    t.timestamp('decided_at', { useTz: true });
    t.text('decision_reason_code');
    t.text('decision_notes');
    t.timestamps(true, true);
  });
  await knex.raw(`
    ALTER TABLE doctor_verifications
      ADD CONSTRAINT verifications_status_valid CHECK (status IN
        ('pending', 'under_review', 'verified', 'rejected', 'suspended', 'withdrawn')),
      ADD CONSTRAINT verifications_decided_consistent CHECK (
        (status IN ('verified', 'rejected', 'suspended', 'withdrawn')) = (decided_at IS NOT NULL)),
      ADD CONSTRAINT verifications_review_consistent CHECK (
        status <> 'under_review' OR (reviewer_user_id IS NOT NULL AND review_started_at IS NOT NULL)),
      ADD CONSTRAINT verifications_reason_required CHECK (
        status NOT IN ('verified', 'rejected', 'suspended') OR decision_reason_code IS NOT NULL),
      ADD CONSTRAINT verifications_reason_valid CHECK (decision_reason_code IS NULL OR decision_reason_code IN (
        'credentials_confirmed', 'registration_not_found', 'registration_mismatch', 'documents_insufficient',
        'duplicate_application', 'registration_lapsed', 'misconduct_report', 'applicant_withdrew', 'other')),
      ADD CONSTRAINT verifications_notes_length CHECK (decision_notes IS NULL OR char_length(decision_notes) <= 1000);
    -- At most one open verification case per doctor.
    CREATE UNIQUE INDEX verifications_open_unique ON doctor_verifications (doctor_id)
      WHERE status IN ('pending', 'under_review');
    CREATE INDEX verifications_queue_idx ON doctor_verifications (status, submitted_at);
  `);

  // ── Care relationships ("My Doctors") ────────────────────────────
  await knex.schema.createTable('care_relationships', (t) => {
    t.uuid('id').primary();
    t.uuid('patient_id').notNullable().references('id').inTable('patients').onDelete('RESTRICT');
    t.uuid('doctor_id').notNullable().references('id').inTable('doctors').onDelete('RESTRICT');
    t.uuid('clinic_id').references('id').inTable('clinics').onDelete('RESTRICT');
    t.text('status').notNullable();
    t.text('initiated_by').notNullable();
    t.uuid('requested_by_user_id')
      .notNullable()
      .references('id')
      .inTable('users')
      .onDelete('RESTRICT');
    // Name shown to the doctor for a patient-initiated request before access exists.
    t.text('patient_display_name');
    t.timestamp('responded_at', { useTz: true });
    t.timestamp('activated_at', { useTz: true });
    t.timestamp('paused_at', { useTz: true });
    t.timestamp('ended_at', { useTz: true });
    t.uuid('ended_by_user_id').references('id').inTable('users').onDelete('RESTRICT');
    t.text('end_reason');
    t.timestamps(true, true);
  });
  await knex.raw(`
    ALTER TABLE care_relationships
      ADD CONSTRAINT care_status_valid CHECK (status IN ('invited', 'pending', 'active', 'paused', 'ended')),
      ADD CONSTRAINT care_initiated_valid CHECK (initiated_by IN ('patient', 'doctor')),
      ADD CONSTRAINT care_initial_state CHECK (
        (initiated_by = 'patient' OR status <> 'pending') AND (initiated_by = 'doctor' OR status <> 'invited')),
      ADD CONSTRAINT care_end_consistent CHECK ((status = 'ended') = (ended_at IS NOT NULL)),
      ADD CONSTRAINT care_active_consistent CHECK (status NOT IN ('active', 'paused') OR activated_at IS NOT NULL),
      ADD CONSTRAINT care_end_reason_valid CHECK (end_reason IS NULL OR end_reason IN
        ('patient_ended', 'doctor_ended', 'declined', 'withdrawn', 'admin_ended')),
      ADD CONSTRAINT care_display_name_length CHECK (patient_display_name IS NULL OR char_length(patient_display_name) <= 120);
    -- One open relationship per patient–doctor pair.
    CREATE UNIQUE INDEX care_open_unique ON care_relationships (patient_id, doctor_id) WHERE status <> 'ended';
    CREATE INDEX care_doctor_idx ON care_relationships (doctor_id, status);
    CREATE INDEX care_patient_idx ON care_relationships (patient_id, status);
    CREATE INDEX care_clinic_idx ON care_relationships (clinic_id) WHERE clinic_id IS NOT NULL;
  `);

  for (const table of [
    'clinics',
    'clinic_memberships',
    'patients',
    'patient_guardianships',
    'doctors',
    'doctor_verifications',
    'care_relationships',
  ]) {
    await knex.raw(
      `CREATE TRIGGER ${table}_set_updated_at BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()`,
    );
  }

  // ── Row-level security (ADR-0017) ────────────────────────────────
  await knex.raw(`
    CREATE SCHEMA authz;
    REVOKE ALL ON SCHEMA authz FROM PUBLIC;
    GRANT USAGE ON SCHEMA authz TO "${app}";

    -- Actor for the current transaction; NULL (deny everything) when unset or malformed.
    CREATE FUNCTION authz.current_user_id() RETURNS uuid
      LANGUAGE sql STABLE SET search_path = pg_catalog AS $fn$
      SELECT CASE
        WHEN current_setting('app.user_id', true) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN current_setting('app.user_id', true)::uuid
      END
    $fn$;

    -- The predicates below are SECURITY DEFINER (owned by the schema owner, which is not
    -- subject to RLS) so that policies can consult other RLS-protected tables without
    -- recursion. They return booleans only and never expose rows.

    CREATE FUNCTION authz.is_patient_self(p_patient uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
      SELECT EXISTS (SELECT 1 FROM patients p
                      WHERE p.id = p_patient AND p.deleted_at IS NULL
                        AND p.user_id = authz.current_user_id())
    $fn$;

    CREATE FUNCTION authz.guardian_scope(p_patient uuid) RETURNS text
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
      SELECT g.access_scope FROM patient_guardianships g
        JOIN patients p ON p.id = g.patient_id AND p.deleted_at IS NULL
       WHERE g.patient_id = p_patient AND g.guardian_user_id = authz.current_user_id()
         AND g.status = 'active'
       ORDER BY (g.access_scope = 'manage') DESC
       LIMIT 1
    $fn$;

    CREATE FUNCTION authz.is_treating_doctor(p_patient uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
      SELECT EXISTS (
        SELECT 1 FROM care_relationships cr
          JOIN doctors d ON d.id = cr.doctor_id
          JOIN users u ON u.id = d.user_id
         WHERE cr.patient_id = p_patient AND cr.status = 'active'
           AND d.user_id = authz.current_user_id()
           AND d.verification_status = 'verified' AND d.profile_status = 'active' AND d.deleted_at IS NULL
           AND u.status = 'active' AND u.deleted_at IS NULL)
    $fn$;

    CREATE FUNCTION authz.is_doctor_user(p_doctor uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
      SELECT EXISTS (SELECT 1 FROM doctors d WHERE d.id = p_doctor AND d.user_id = authz.current_user_id()
                                             AND d.deleted_at IS NULL)
    $fn$;

    CREATE FUNCTION authz.is_dependent_creator(p_patient uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
      SELECT EXISTS (SELECT 1 FROM patients p WHERE p.id = p_patient AND p.user_id IS NULL
                                              AND p.created_by_user_id = authz.current_user_id())
    $fn$;

    -- Who may see a patient's profile row. Clinic membership alone never qualifies.
    CREATE FUNCTION authz.can_view_patient(p_patient uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
      SELECT authz.is_patient_self(p_patient)
          OR authz.guardian_scope(p_patient) IS NOT NULL
          OR authz.is_treating_doctor(p_patient)
    $fn$;

    -- Who may change a patient's profile or act on their behalf.
    CREATE FUNCTION authz.can_manage_patient(p_patient uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
      SELECT authz.is_patient_self(p_patient) OR authz.guardian_scope(p_patient) = 'manage'
    $fn$;

    -- Doctor invitations: resolves an account email to a patient id without exposing
    -- the profile. Returns NULL when there is no eligible patient (enumeration-safe use).
    CREATE FUNCTION authz.patient_id_for_invite(p_email citext) RETURNS uuid
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
      SELECT p.id FROM patients p JOIN users u ON u.id = p.user_id
       WHERE u.email = p_email AND u.status = 'active' AND u.deleted_at IS NULL
         AND p.deleted_at IS NULL AND p.status = 'active'
         AND authz.current_user_id() IS NOT NULL
    $fn$;

    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA authz FROM PUBLIC;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA authz TO "${app}";

    ALTER TABLE patients ENABLE ROW LEVEL SECURITY;
    CREATE POLICY patients_select ON patients FOR SELECT USING (authz.can_view_patient(id));
    CREATE POLICY patients_insert ON patients FOR INSERT WITH CHECK (
      created_by_user_id = authz.current_user_id()
      AND (user_id IS NULL OR user_id = authz.current_user_id()));
    CREATE POLICY patients_update ON patients FOR UPDATE
      USING (authz.can_manage_patient(id)) WITH CHECK (authz.can_manage_patient(id));

    ALTER TABLE patient_guardianships ENABLE ROW LEVEL SECURITY;
    CREATE POLICY guardianships_select ON patient_guardianships FOR SELECT USING (
      guardian_user_id = authz.current_user_id() OR authz.is_patient_self(patient_id));
    -- M2 supports guardianships only for dependents the guardian created.
    CREATE POLICY guardianships_insert ON patient_guardianships FOR INSERT WITH CHECK (
      guardian_user_id = authz.current_user_id() AND created_by_user_id = authz.current_user_id()
      AND authz.is_dependent_creator(patient_id));
    CREATE POLICY guardianships_update ON patient_guardianships FOR UPDATE
      USING (guardian_user_id = authz.current_user_id() OR authz.is_patient_self(patient_id))
      WITH CHECK (guardian_user_id = authz.current_user_id() OR authz.is_patient_self(patient_id));

    ALTER TABLE care_relationships ENABLE ROW LEVEL SECURITY;
    CREATE POLICY care_select ON care_relationships FOR SELECT USING (
      authz.is_patient_self(patient_id) OR authz.guardian_scope(patient_id) IS NOT NULL
      OR authz.is_doctor_user(doctor_id));
    CREATE POLICY care_insert ON care_relationships FOR INSERT WITH CHECK (
      requested_by_user_id = authz.current_user_id()
      AND ((initiated_by = 'patient' AND authz.can_manage_patient(patient_id))
        OR (initiated_by = 'doctor' AND authz.is_doctor_user(doctor_id))));
    CREATE POLICY care_update ON care_relationships FOR UPDATE
      USING (authz.can_manage_patient(patient_id) OR authz.is_doctor_user(doctor_id))
      WITH CHECK (authz.can_manage_patient(patient_id) OR authz.is_doctor_user(doctor_id));
    -- No DELETE policies: patient-scoped rows are never deleted by the application.
  `);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw(`
    DROP TABLE IF EXISTS care_relationships;
    DROP TABLE IF EXISTS doctor_verifications;
    DROP TABLE IF EXISTS doctors;
    DROP TABLE IF EXISTS patient_guardianships;
    DROP TABLE IF EXISTS patients;
    DROP FUNCTION IF EXISTS public.patients_lock_owner();
    DROP SCHEMA IF EXISTS authz CASCADE;
    DROP VIEW IF EXISTS effective_role_grants;
    DROP TABLE IF EXISTS clinic_memberships;
    DROP TRIGGER IF EXISTS user_roles_scope ON user_roles;
    DROP FUNCTION IF EXISTS public.user_roles_enforce_scope();
    DROP INDEX IF EXISTS user_roles_clinic_idx;
    ALTER TABLE user_roles DROP CONSTRAINT IF EXISTS user_roles_clinic_fk;
    DELETE FROM user_roles WHERE clinic_id IS NOT NULL;
    DROP TABLE IF EXISTS clinics;
  `);
  const codes = NEW_PERMISSIONS.map(([code]) => code);
  await knex('role_permissions')
    .whereIn('permission_id', knex('permissions').select('id').whereIn('code', codes))
    .del();
  await knex('permissions').whereIn('code', codes).del();
  await knex.schema.alterTable('roles', (t) => t.dropColumn('scope'));
}
