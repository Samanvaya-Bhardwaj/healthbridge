// Minimal runtime for operational scripts: same config, repositories and services as the
// API (no duplicated business logic), without HTTP, Redis or email delivery.

import { loadConfig } from '../../src/config/index.js';
import { createLogger } from '../../src/core/logger/index.js';
import { createKnex } from '../../src/core/db/knex.js';
import { createNoopMailer } from '../../src/core/mail/mailer.js';
import { createContainer } from '../../src/container.js';

export function createScriptRuntime(name) {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, appEnv: config.appEnv }).child({
    script: name,
  });
  const knex = createKnex(config.db, `healthbridge-${name}`);
  const container = createContainer({ config, logger, knex, mailer: createNoopMailer({ logger }) });
  return { config, logger, knex, container, close: () => knex.destroy() };
}

/** Parses `--key value` / `--key=value` arguments. */
export function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const [key, inline] = argv[i].replace(/^--/, '').split('=');
    args[key] = inline ?? argv[i + 1];
    if (inline === undefined) i += 1;
  }
  return args;
}
