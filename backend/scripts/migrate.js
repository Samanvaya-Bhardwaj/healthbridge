#!/usr/bin/env node
// Usage: node scripts/migrate.js <latest|rollback|status>
// Waits for PostgreSQL to accept connections, then runs the requested command.

import knexFactory from 'knex';
import { migrationConfig } from '../knexfile.js';

const command = process.argv[2] ?? 'status';
const MAX_ATTEMPTS = 30;

const log = (msg, extra = {}) =>
  console.log(JSON.stringify({ level: 'info', service: 'healthbridge-migrate', msg, ...extra }));

async function waitForDatabase(knex) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      await knex.raw('select 1');
      return;
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) throw err;
      log('database not ready, retrying', { attempt, error: err.code ?? err.message });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

async function main() {
  const knex = knexFactory(migrationConfig());
  try {
    await waitForDatabase(knex);
    if (command === 'latest') {
      const [batch, applied] = await knex.migrate.latest();
      log(applied.length ? 'migrations applied' : 'already up to date', { batch, applied });
    } else if (command === 'rollback') {
      const [batch, reverted] = await knex.migrate.rollback();
      log('migrations rolled back', { batch, reverted });
    } else if (command === 'status') {
      const [completed, pending] = await knex.migrate.list();
      log('migration status', {
        completed: completed.map((m) => m.name),
        pending: pending.map((m) => m.file),
      });
      if (pending.length) process.exitCode = 2;
    } else {
      throw new Error(`Unknown command "${command}". Use latest, rollback or status.`);
    }
  } finally {
    await knex.destroy();
  }
}

main().catch((err) => {
  console.error(
    JSON.stringify({
      level: 'fatal',
      service: 'healthbridge-migrate',
      msg: 'migration failed',
      error: err.message,
    }),
  );
  process.exit(1);
});
