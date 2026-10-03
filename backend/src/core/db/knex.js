import knexFactory from 'knex';
import pg from 'pg';
import { pgSsl } from './ssl.js';

// Calendar dates (DATE, OID 1082) stay 'YYYY-MM-DD' strings. node-postgres would otherwise
// build a JS Date at local midnight, which serialises as the previous day east of UTC.
pg.types.setTypeParser(1082, (value) => value);

/**
 * Runtime database connection using the least-privilege application role.
 * Migrations use a separate owner role (see scripts/migrate.js).
 * @param {{ host: string, port: number, database: string, user: string, password: string, poolMax: number, ssl?: string, sslCa?: string }} db
 * @param {string} applicationName
 */
export function createKnex(db, applicationName = 'healthbridge-api') {
  return knexFactory({
    client: 'pg',
    connection: {
      host: db.host,
      port: db.port,
      database: db.database,
      user: db.user,
      password: db.password,
      ssl: pgSsl({ mode: db.ssl, caBase64: db.sslCa }),
      application_name: applicationName,
      statement_timeout: 15_000,
      idle_in_transaction_session_timeout: 30_000,
    },
    pool: { min: 0, max: db.poolMax },
    acquireConnectionTimeout: 10_000,
  });
}
