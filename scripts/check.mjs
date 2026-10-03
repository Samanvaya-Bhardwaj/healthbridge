#!/usr/bin/env node
// Runs every quality gate against the running local stack (see docs/RUNNING.md):
//
//   npm run check            lint, format, unit, integration, frontend, build, AI service,
//                            dependency audit, browser e2e, backup + restore drill
//   npm run check -- --quick static checks and unit tests only (no running stack needed)
//
// Prerequisites: `npm ci` once, and `npm start` for everything except --quick.
// The integration suite refuses to run beside a live worker, so the worker is paused
// for it and always restarted afterwards.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { values: opts } = parseArgs({ options: { quick: { type: 'boolean', default: false } } });
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

if (!existsSync(join(root, 'node_modules'))) {
  console.error('Run `npm ci` first (installs the test tooling).');
  process.exit(1);
}
const env = existsSync(join(root, '.env'))
  ? parseEnv(readFileSync(join(root, '.env'), 'utf8'))
  : {};

const results = [];
function gate(name, cmd, args, { cwd = root, extraEnv = {} } = {}) {
  process.stdout.write(`\x1b[36m▶ ${name}\x1b[0m\n`);
  const started = Date.now();
  const r = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
    shell: process.platform === 'win32' && /\.cmd$/.test(cmd),
  });
  const ok = r.status === 0;
  results.push({ name, ok, seconds: Math.round((Date.now() - started) / 1000) });
  return ok;
}
const compose = (...args) =>
  spawnSync('docker', ['compose', ...args], { cwd: root, stdio: 'ignore' }).status === 0;

gate('Lint (ESLint)', npx, ['eslint', '.']);
gate('Formatting (Prettier)', npx, ['prettier', '--check', '.']);
gate('Backend unit tests', npm, ['run', 'test', '-w', 'backend']);
gate('Frontend tests', npm, ['run', 'test', '-w', 'frontend']);
gate('Frontend production build', npm, ['run', 'build', '-w', 'frontend']);
gate('Dependency audit (production)', npm, ['audit', '--omit=dev', '--audit-level=high']);

if (!opts.quick) {
  if (!compose('exec', '-T', 'api', 'true')) {
    console.error('\nThe stack is not running. Start it with `npm start`, or use --quick.');
    process.exit(1);
  }
  const project = 'healthbridge';
  compose('stop', 'worker');
  try {
    gate('Backend integration tests (PostgreSQL, Redis, MinIO)', npm, [
      'run',
      'test:integration',
      '-w',
      'backend',
    ]);
  } finally {
    compose('up', '-d', '--wait', 'worker');
  }

  if (
    gate('AI service image (dev)', 'docker', [
      'build',
      '-q',
      '--target',
      'dev',
      '-t',
      'healthbridge-ai:dev',
      'ai-service',
    ])
  ) {
    gate('AI service lint + tests (with database)', 'docker', [
      'run',
      '--rm',
      '--network',
      `${project}_private`,
      '-e',
      'AI_DB_TESTS=1',
      '-e',
      'DB_HOST=postgres',
      '-e',
      `POSTGRES_DB=${env.POSTGRES_DB}`,
      '-e',
      `DB_AI_USER=${env.DB_AI_USER}`,
      '-e',
      `DB_AI_PASSWORD=${env.DB_AI_PASSWORD}`,
      'healthbridge-ai:dev',
      'sh',
      '-c',
      'ruff check . && ruff format --check . && pytest -q',
    ]);
  }

  gate('Browser engine for e2e (Playwright Chromium)', npm, [
    'exec',
    '-w',
    'e2e',
    '--',
    'playwright',
    'install',
    'chromium',
  ]);
  gate('Browser end-to-end journeys (Playwright)', npm, ['run', 'test:e2e']);

  if (
    gate('Backup image', 'docker', [
      'build',
      '-q',
      '-t',
      'healthbridge-backup:local',
      'infra/deploy/backup',
    ])
  ) {
    gate('Backup + restore drill (throw-away key, scratch database)', process.execPath, [
      'scripts/backup-drill.mjs',
    ]);
  }
}

console.log('\nResults');
for (const r of results) {
  console.log(
    `  ${r.ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${r.name} (${r.seconds}s)`,
  );
}
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} gate(s) failed.` : `\nAll ${results.length} gates passed.`);
process.exit(failed ? 1 : 0);
