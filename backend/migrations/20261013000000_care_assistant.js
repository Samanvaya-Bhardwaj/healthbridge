/**
 * M13.1: care assistant foundation (ADR-0029).
 *
 * - `assistant:use`: patients (and guardians, for dependents they manage) may use the
 *   HealthBridge Assistant. Not granted to doctors, clinic staff, admins or support.
 * - `agent_sessions`: short-lived, bounded, STRUCTURED assistant state (intent, the kind
 *   of doctor, day and time window, IDs of doctors and slots the backend returned).
 *   Never message text or a transcript: the browser keeps the visible conversation.
 *   Owned by the acting user (RLS); the patient scope is fixed at creation and
 *   re-checked by AccessPolicy on every turn. Expires 24 hours after creation and is
 *   deleted by the maintenance sweep (system purpose `assistant`).
 * - The AI service gains nothing: agent runs reuse `ai.ai_runs`; `hb_ai` still has no
 *   access to `public`.
 */

const NEW_PERMISSIONS = [
  ['assistant:use', 'Use the HealthBridge Assistant for self or dependents'],
];
const NEW_ROLE_PERMISSIONS = { PATIENT: ['assistant:use'] };

const M10_PURPOSES = `('payments', 'scheduler', 'notifications', 'documents', 'consents', 'timeline', 'prescriptions', 'followups')`;
const M13_PURPOSES = `('payments', 'scheduler', 'notifications', 'documents', 'consents', 'timeline', 'prescriptions', 'followups', 'assistant')`;
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
    ${systemPurposeFn(M13_PURPOSES)}

    CREATE TABLE agent_sessions (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
      patient_id uuid NOT NULL REFERENCES patients (id) ON DELETE RESTRICT,
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
      -- Structured state only, validated by the backend before every write.
      state jsonb NOT NULL DEFAULT '{}'::jsonb,
      version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
      turn_count smallint NOT NULL DEFAULT 0 CHECK (turn_count BETWEEN 0 AND 60),
      last_run_id uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      CONSTRAINT agent_sessions_state_object CHECK (jsonb_typeof(state) = 'object'),
      CONSTRAINT agent_sessions_state_bounded CHECK (pg_column_size(state) <= 16384),
      CONSTRAINT agent_sessions_short_lived CHECK (
        expires_at > created_at AND expires_at <= created_at + interval '24 hours')
    );
    CREATE INDEX agent_sessions_user_idx ON agent_sessions (user_id, created_at DESC);
    CREATE INDEX agent_sessions_expiry_idx ON agent_sessions (expires_at);
    CREATE TRIGGER agent_sessions_set_updated_at BEFORE UPDATE ON agent_sessions
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

    -- Who, for whom and until when never change; an ended session stays ended.
    CREATE FUNCTION agent_sessions_guard() RETURNS trigger
      LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
    BEGIN
      IF NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id OR NEW.patient_id <> OLD.patient_id
         OR NEW.created_at <> OLD.created_at OR NEW.expires_at <> OLD.expires_at
         OR (OLD.status = 'ended' AND NEW.status <> 'ended') THEN
        RAISE EXCEPTION 'agent session identity is immutable' USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END $fn$;
    CREATE TRIGGER agent_sessions_guard BEFORE UPDATE ON agent_sessions
      FOR EACH ROW EXECUTE FUNCTION agent_sessions_guard();

    ALTER TABLE agent_sessions ENABLE ROW LEVEL SECURITY;
    CREATE POLICY agent_sessions_own_select ON agent_sessions FOR SELECT USING (
      user_id = authz.current_user_id() OR authz.system_purpose() = 'assistant');
    CREATE POLICY agent_sessions_own_insert ON agent_sessions FOR INSERT
      WITH CHECK (user_id = authz.current_user_id());
    CREATE POLICY agent_sessions_own_update ON agent_sessions FOR UPDATE
      USING (user_id = authz.current_user_id()) WITH CHECK (user_id = authz.current_user_id());
    -- Only the retention sweep deletes (expired sessions).
    CREATE POLICY agent_sessions_system_delete ON agent_sessions FOR DELETE
      USING (authz.system_purpose() = 'assistant' AND expires_at <= now());
    REVOKE TRUNCATE ON agent_sessions FROM "${app}";

    COMMENT ON TABLE agent_sessions IS
      'Care assistant state (ADR-0029): structured, bounded, 24h; never message text.';
  `);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw(`
    DROP TABLE IF EXISTS agent_sessions;
    DROP FUNCTION IF EXISTS agent_sessions_guard();
    ${systemPurposeFn(M10_PURPOSES)}
  `);
  const codes = NEW_PERMISSIONS.map(([code]) => code);
  await knex('role_permissions')
    .whereIn('permission_id', knex('permissions').select('id').whereIn('code', codes))
    .delete();
  await knex('permissions').whereIn('code', codes).delete();
}
