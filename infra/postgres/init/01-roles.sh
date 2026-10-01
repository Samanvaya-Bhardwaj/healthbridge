#!/bin/sh
# Creates the least-privilege runtime roles (idempotent).
#
# Runs automatically on first initialisation of the Postgres container
# (/docker-entrypoint-initdb.d) and is re-run by CI against a fresh database.
# Grants on schemas/tables are managed by migrations, not here.
#
# Required env: POSTGRES_USER, POSTGRES_DB, DB_APP_USER, DB_APP_PASSWORD, DB_AI_USER, DB_AI_PASSWORD
set -eu

: "${DB_APP_USER:?DB_APP_USER is required}"
: "${DB_APP_PASSWORD:?DB_APP_PASSWORD is required}"
: "${DB_AI_USER:?DB_AI_USER is required}"
: "${DB_AI_PASSWORD:?DB_AI_PASSWORD is required}"

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set=app_user="$DB_APP_USER" \
  --set=app_password="$DB_APP_PASSWORD" \
  --set=ai_user="$DB_AI_USER" \
  --set=ai_password="$DB_AI_PASSWORD" \
  --set=db_name="$POSTGRES_DB" <<'SQL'
-- psql variables are quoted with :'var' (literal) and :"var" (identifier): no SQL injection.
SELECT format('CREATE ROLE %I', :'app_user')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user') \gexec
SELECT format('CREATE ROLE %I', :'ai_user')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'ai_user') \gexec

ALTER ROLE :"app_user" WITH LOGIN PASSWORD :'app_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION CONNECTION LIMIT 50;
ALTER ROLE :"ai_user" WITH LOGIN PASSWORD :'ai_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION CONNECTION LIMIT 20;

-- Only explicitly granted roles may connect.
REVOKE CONNECT ON DATABASE :"db_name" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db_name" TO :"app_user", :"ai_user";

-- Defensive defaults for the runtime roles.
ALTER ROLE :"app_user" SET statement_timeout = '15s';
ALTER ROLE :"ai_user" SET statement_timeout = '15s';
ALTER ROLE :"app_user" SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE :"ai_user" SET idle_in_transaction_session_timeout = '30s';
SQL

echo "healthbridge: runtime roles ready (${DB_APP_USER}, ${DB_AI_USER})"
