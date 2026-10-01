/**
 * M0 foundation: extensions, schemas, least-privilege grants, shared trigger function.
 * No product tables yet — those arrive with their milestones.
 *
 * Schemas:
 *   public — core application data (owned by the backend)
 *   ai     — AI artifacts: runs, sources, chunks, agent tasks (ADR-0004, ADR-0012)
 *   audit  — append-only audit and record-access logs (ADR-0006)
 *
 * Runtime roles (created with LOGIN by infra/postgres/init; created NOLOGIN here if absent
 * so the migration is self-contained, e.g. in CI):
 *   DB_APP_USER — Node backend: DML on public; SELECT/INSERT only on audit (append-only)
 *   DB_AI_USER  — AI service: ai schema only; no access to core clinical tables
 */

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

function roleNames() {
  const app = process.env.DB_APP_USER ?? 'hb_app';
  const ai = process.env.DB_AI_USER ?? 'hb_ai';
  for (const role of [app, ai]) {
    if (!IDENTIFIER.test(role)) throw new Error(`Invalid role name: ${role}`);
  }
  return { app, ai };
}

const EXTENSIONS = ['pgcrypto', 'citext', 'btree_gist', 'pg_trgm', 'vector'];

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  const { app, ai } = roleNames();

  for (const extension of EXTENSIONS) {
    await knex.raw(`CREATE EXTENSION IF NOT EXISTS ${extension}`);
  }

  for (const role of [app, ai]) {
    // Role names are validated identifiers above; DO blocks cannot take bind parameters.
    await knex.raw(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
          CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
        END IF;
      END
      $$;
    `);
  }

  await knex.raw(`
    CREATE SCHEMA IF NOT EXISTS ai;
    CREATE SCHEMA IF NOT EXISTS audit;

    -- Nobody gets implicit access to any schema; access is granted explicitly per role.
    REVOKE ALL ON SCHEMA public FROM PUBLIC;
    REVOKE ALL ON SCHEMA ai FROM PUBLIC;
    REVOKE ALL ON SCHEMA audit FROM PUBLIC;

    GRANT USAGE ON SCHEMA public, ai, audit TO "${app}";
    GRANT USAGE ON SCHEMA ai TO "${ai}";

    -- Privileges for tables created later by the migration owner.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${app}";
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT USAGE, SELECT ON SEQUENCES TO "${app}";

    -- AI artifacts: the AI service writes proposals; the backend reads them and records
    -- review state. Neither role may DELETE AI history.
    ALTER DEFAULT PRIVILEGES IN SCHEMA ai
      GRANT SELECT, INSERT, UPDATE ON TABLES TO "${ai}", "${app}";
    ALTER DEFAULT PRIVILEGES IN SCHEMA ai
      GRANT USAGE, SELECT ON SEQUENCES TO "${ai}", "${app}";

    -- Audit is append-only for the application.
    ALTER DEFAULT PRIVILEGES IN SCHEMA audit
      GRANT SELECT, INSERT ON TABLES TO "${app}";
    ALTER DEFAULT PRIVILEGES IN SCHEMA audit
      GRANT USAGE, SELECT ON SEQUENCES TO "${app}";

    CREATE OR REPLACE FUNCTION public.set_updated_at()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    BEGIN
      NEW.updated_at := now();
      RETURN NEW;
    END
    $fn$;

    COMMENT ON FUNCTION public.set_updated_at() IS
      'BEFORE UPDATE trigger: maintains updated_at on mutable tables.';
    COMMENT ON SCHEMA ai IS 'AI artifacts and proposals. Never authoritative clinical data (ADR-0004).';
    COMMENT ON SCHEMA audit IS 'Append-only audit and record-access logs (ADR-0006).';
  `);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  const { app, ai } = roleNames();
  await knex.raw(`
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM "${app}";
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM "${app}";
    ALTER DEFAULT PRIVILEGES IN SCHEMA ai REVOKE ALL ON TABLES FROM "${ai}", "${app}";
    ALTER DEFAULT PRIVILEGES IN SCHEMA ai REVOKE ALL ON SEQUENCES FROM "${ai}", "${app}";
    ALTER DEFAULT PRIVILEGES IN SCHEMA audit REVOKE ALL ON TABLES FROM "${app}";
    ALTER DEFAULT PRIVILEGES IN SCHEMA audit REVOKE ALL ON SEQUENCES FROM "${app}";

    DROP FUNCTION IF EXISTS public.set_updated_at();
    DROP SCHEMA IF EXISTS audit;
    DROP SCHEMA IF EXISTS ai;

    REVOKE USAGE ON SCHEMA public FROM "${app}";
    GRANT USAGE ON SCHEMA public TO PUBLIC;
  `);
  for (const extension of [...EXTENSIONS].reverse()) {
    await knex.raw(`DROP EXTENSION IF EXISTS ${extension}`);
  }
}
