/**
 * M11: password reset and email verification (ADR-0015 follow-up).
 *
 * `account_tokens` holds single-use, short-lived tokens. Only SHA-256(secret) is stored;
 * the secret travels once, by email, in a link fragment. A token can only be consumed
 * (`used_at` set once); nothing else about it may change, and the app cannot delete it.
 * Sessions gain the `password_reset` revocation reason.
 */

const REVOKE_REASONS_M1 = `'logout', 'user_revoked', 'admin_revoked', 'password_changed', 'account_disabled',
        'refresh_token_reuse', 'expired'`;

export async function up(knex) {
  const app = process.env.DB_APP_USER ?? 'hb_app';
  await knex.raw(`
    CREATE TABLE account_tokens (
      id          uuid PRIMARY KEY,
      user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      purpose     text NOT NULL CHECK (purpose IN ('password_reset', 'email_verification')),
      token_hash  text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
      created_at  timestamptz NOT NULL DEFAULT now(),
      expires_at  timestamptz NOT NULL,
      used_at     timestamptz,
      CONSTRAINT account_tokens_expiry_after_creation CHECK (expires_at > created_at),
      CONSTRAINT account_tokens_short_lived CHECK (expires_at <= created_at + interval '48 hours')
    );
    CREATE INDEX account_tokens_open_idx ON account_tokens (user_id, purpose)
      WHERE used_at IS NULL;

    CREATE FUNCTION account_tokens_consume_only() RETURNS trigger
      LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
      BEGIN
        IF OLD.used_at IS NOT NULL
           OR NEW.used_at IS NULL
           OR (NEW.id, NEW.user_id, NEW.purpose, NEW.token_hash, NEW.created_at, NEW.expires_at)
              IS DISTINCT FROM
              (OLD.id, OLD.user_id, OLD.purpose, OLD.token_hash, OLD.created_at, OLD.expires_at)
        THEN
          RAISE EXCEPTION 'account tokens can only be consumed once' USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END
    $fn$;
    CREATE TRIGGER account_tokens_consume_only BEFORE UPDATE ON account_tokens
      FOR EACH ROW EXECUTE FUNCTION account_tokens_consume_only();
    REVOKE DELETE, TRUNCATE ON account_tokens FROM "${app}";

    ALTER TABLE sessions DROP CONSTRAINT sessions_revoked_reason_valid;
    ALTER TABLE sessions ADD CONSTRAINT sessions_revoked_reason_valid CHECK (
      revoked_reason IS NULL OR revoked_reason IN (${REVOKE_REASONS_M1}, 'password_reset'));
  `);
}

export async function down(knex) {
  await knex.raw(`
    UPDATE sessions SET revoked_reason = 'password_changed' WHERE revoked_reason = 'password_reset';
    ALTER TABLE sessions DROP CONSTRAINT sessions_revoked_reason_valid;
    ALTER TABLE sessions ADD CONSTRAINT sessions_revoked_reason_valid CHECK (
      revoked_reason IS NULL OR revoked_reason IN (${REVOKE_REASONS_M1}));
    DROP TABLE account_tokens;
    DROP FUNCTION account_tokens_consume_only();
  `);
}
