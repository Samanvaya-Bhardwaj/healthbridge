import knexFactory from 'knex';

/**
 * Runtime database connection using the least-privilege application role.
 * Migrations use a separate owner role (see scripts/migrate.js).
 * @param {{ host: string, port: number, database: string, user: string, password: string, poolMax: number }} db
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
      application_name: applicationName,
      statement_timeout: 15_000,
      idle_in_transaction_session_timeout: 30_000,
    },
    pool: { min: 0, max: db.poolMax },
    acquireConnectionTimeout: 10_000,
  });
}
