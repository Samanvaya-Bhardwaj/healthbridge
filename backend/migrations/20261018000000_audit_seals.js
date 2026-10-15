/**
 * Step 9: tamper-evident audit log (ADR-0035).
 *
 * `audit.audit_seals` is a keyed hash chain over consecutive time ranges of
 * `audit.audit_logs`. Each seal covers [sealed_from, sealed_to), starts exactly where the
 * previous one ended, and records the row count, a SHA-256 over the rows in a canonical
 * order, and an HMAC that also covers the previous seal. Changing, deleting or back-dating
 * an audit row inside a sealed range, or removing a seal, no longer verifies. The HMAC key
 * is derived from the clinical data key, which never reaches the database.
 *
 * The application role keeps SELECT/INSERT only (default privileges of the audit schema),
 * and triggers reject UPDATE, DELETE and TRUNCATE, as for the audit log itself.
 */

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE audit.audit_seals (
      seq bigint PRIMARY KEY CHECK (seq >= 1),
      sealed_from timestamptz NOT NULL,
      sealed_to timestamptz NOT NULL,
      row_count integer NOT NULL CHECK (row_count >= 0),
      rows_sha256 text NOT NULL CHECK (rows_sha256 ~ '^[0-9a-f]{64}$'),
      chain_hmac text NOT NULL CHECK (chain_hmac ~ '^[0-9a-f]{64}$'),
      key_id text NOT NULL CHECK (key_id ~ '^[a-z0-9_-]{1,32}$'),
      sealed_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT audit_seals_range CHECK (sealed_to > sealed_from),
      CONSTRAINT audit_seals_from_unique UNIQUE (sealed_from)
    );

    -- Seals are contiguous: the first starts at the epoch, each later one exactly where
    -- the previous one ended, so every moment is covered by exactly one seal.
    CREATE FUNCTION audit.audit_seals_contiguous() RETURNS trigger LANGUAGE plpgsql AS $fn$
    DECLARE
      previous_to timestamptz;
    BEGIN
      IF NEW.seq = 1 THEN
        IF NEW.sealed_from <> 'epoch'::timestamptz THEN
          RAISE EXCEPTION 'the first audit seal starts at the epoch' USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END IF;
      SELECT sealed_to INTO previous_to FROM audit.audit_seals WHERE seq = NEW.seq - 1;
      IF previous_to IS NULL OR previous_to <> NEW.sealed_from THEN
        RAISE EXCEPTION 'audit seals must be contiguous' USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END
    $fn$;
    CREATE TRIGGER audit_seals_contiguous BEFORE INSERT ON audit.audit_seals
      FOR EACH ROW EXECUTE FUNCTION audit.audit_seals_contiguous();

    CREATE FUNCTION audit.reject_seal_mutation() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      RAISE EXCEPTION 'audit.audit_seals is append-only' USING ERRCODE = 'insufficient_privilege';
    END
    $fn$;
    CREATE TRIGGER audit_seals_no_update_delete BEFORE UPDATE OR DELETE ON audit.audit_seals
      FOR EACH ROW EXECUTE FUNCTION audit.reject_seal_mutation();
    CREATE TRIGGER audit_seals_no_truncate BEFORE TRUNCATE ON audit.audit_seals
      FOR EACH STATEMENT EXECUTE FUNCTION audit.reject_seal_mutation();

    -- Sealing and verification read ranges in (occurred_at, id) order.
    CREATE INDEX audit_logs_seal_order_idx ON audit.audit_logs (occurred_at, id);

    COMMENT ON TABLE audit.audit_seals IS
      'Keyed hash chain over consecutive ranges of audit.audit_logs (ADR-0035). Append-only.';
  `);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw(`
    DROP INDEX IF EXISTS audit.audit_logs_seal_order_idx;
    DROP TABLE IF EXISTS audit.audit_seals;
    DROP FUNCTION IF EXISTS audit.audit_seals_contiguous();
    DROP FUNCTION IF EXISTS audit.reject_seal_mutation();
  `);
}
