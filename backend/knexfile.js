// Knex configuration for MIGRATIONS ONLY.
// Migrations run as the schema owner (POSTGRES_USER). Running services connect as
// least-privilege roles (DB_APP_USER / DB_AI_USER) and cannot alter the schema.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export function migrationConfig(env = process.env) {
  const required = ['DB_HOST', 'POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD'];
  const missing = required.filter((name) => !env[name]);
  if (missing.length) {
    throw new Error(`Missing environment variables for migrations: ${missing.join(', ')}`);
  }
  return {
    client: 'pg',
    connection: {
      host: env.DB_HOST,
      port: Number(env.DB_PORT ?? 5432),
      database: env.POSTGRES_DB,
      user: env.POSTGRES_USER,
      password: env.POSTGRES_PASSWORD,
      application_name: 'healthbridge-migrate',
    },
    pool: { min: 0, max: 2 },
    migrations: {
      directory: join(here, 'migrations'),
      tableName: 'knex_migrations',
      loadExtensions: ['.js'],
      // Each migration runs in its own transaction; a failure rolls back cleanly.
      disableTransactions: false,
    },
  };
}

export default migrationConfig();
