#!/usr/bin/env node
// One command to run the whole application locally (see docs/RUNNING.md):
//
//   npm start                      env + build + start every service + demo data + summary
//   npm start -- --observability   also Prometheus and Grafana
//   npm start -- --scanner         use the real ClamAV scanner instead of the fake one
//   npm start -- --video           real video consultations (local LiveKit server)
//   npm start -- --no-build        skip image builds (faster restarts)
//   npm start -- --no-seed         do not (re)apply the synthetic demo data
//
// Needs only Node.js 24 and Docker (Compose v2): no `npm install` required to run.
// Synthetic data only (ADR-0008).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv, parseArgs } from 'node:util';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { values: opts } = parseArgs({
  options: {
    observability: { type: 'boolean', default: false },
    scanner: { type: 'boolean', default: false },
    video: { type: 'boolean', default: false },
    'no-build': { type: 'boolean', default: false },
    'no-seed': { type: 'boolean', default: false },
  },
});

const step = (msg) => console.log(`\n\x1b[36m▶ ${msg}\x1b[0m`);
const fail = (msg) => {
  console.error(`\n\x1b[31m✖ ${msg}\x1b[0m`);
  process.exit(1);
};
function run(cmd, args, { env, quiet = false } = {}) {
  const result = spawnSync(cmd, args, {
    cwd: root,
    stdio: quiet ? 'pipe' : 'inherit',
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  if (result.error) fail(`${cmd} could not be started: ${result.error.message}`);
  return result;
}

// 1. Prerequisites.
const [major] = process.versions.node.split('.').map(Number);
if (major < 24) fail(`Node.js 24+ is required (found ${process.versions.node}).`);
const docker = run('docker', ['compose', 'version'], { quiet: true });
if (docker.status !== 0) fail('Docker with Compose v2 is required and must be running.');
if (run('docker', ['info'], { quiet: true }).status !== 0) {
  fail('Docker is installed but not running. Start Docker Desktop and try again.');
}

if (/onedrive|dropbox|google drive|icloud/i.test(root)) {
  console.warn(
    '\n\x1b[33m! This folder is synced by a cloud drive. Syncing node_modules and Docker bind\n' +
      '  mounts is slow and can corrupt files. Prefer e.g. C:\\dev\\healthbridge (ADR-0014).\x1b[0m',
  );
}

// 2. Environment: create on first run, otherwise only add newly introduced variables.
// All checkouts share one Compose project ("healthbridge") and therefore one set of data
// volumes. A NEW .env would carry new database passwords that the existing data does not
// accept, so stop with clear choices instead of failing later in the migration step.
const freshEnv = !existsSync(join(root, '.env'));
const existingData =
  run('docker', ['volume', 'inspect', 'healthbridge_postgres-data'], { quiet: true }).status === 0;
if (freshEnv && existingData) {
  fail(
    'HealthBridge data already exists in Docker (from another copy of the project or an\n' +
      '  earlier .env), and its passwords are not in this folder. Choose one:\n' +
      '    • start fresh (deletes the local synthetic demo data):  npm run reset  then  npm start\n' +
      '    • keep that data: copy the .env from the other copy into this folder, then  npm start',
  );
}
step(freshEnv ? 'Creating .env with fresh local secrets' : 'Checking .env');
const gen = run(process.execPath, [
  'scripts/generate-env.mjs',
  ...(existsSync(join(root, '.env')) ? ['--update'] : []),
]);
if (gen.status !== 0) fail('Could not prepare .env.');
const env = parseEnv(readFileSync(join(root, '.env'), 'utf8'));

// 3. Build and start everything; wait until every service reports healthy.
const profiles = [
  ...(opts.observability ? ['--profile', 'observability'] : []),
  ...(opts.scanner ? ['--profile', 'scanner'] : []),
  ...(opts.video ? ['--profile', 'video'] : []),
];
const livekitOrigins = (url) => {
  const ws = new URL(url);
  const http = new URL(url);
  http.protocol = ws.protocol === 'wss:' ? 'https:' : 'http:';
  return `${ws.origin} ${http.origin}`;
};
// Command-line choices override .env for this run only (Compose: shell env wins).
const composeEnv = {
  ...(opts.scanner ? { DOCUMENT_SCANNER: 'clamav', CLAMAV_HOST: 'clamav' } : {}),
  ...(opts.video
    ? {
        VIDEO_PROVIDER: 'livekit',
        HB_MEDIA: 'on',
        // LiveKit signals over WebSocket and falls back to HTTP(S) on the same host.
        HB_CSP_CONNECT_EXTRA: livekitOrigins(env.LIVEKIT_URL || 'ws://localhost:7880'),
      }
    : { VIDEO_PROVIDER: env.VIDEO_PROVIDER || 'mock', HB_MEDIA: 'off', HB_CSP_CONNECT_EXTRA: '' }),
};
step(
  `Starting HealthBridge${opts['no-build'] ? '' : ' (building images; the first run takes a few minutes)'}`,
);
const up = run(
  'docker',
  [
    'compose',
    ...profiles,
    'up',
    '-d',
    '--wait',
    '--wait-timeout',
    opts.scanner ? '900' : '420',
    ...(opts['no-build'] ? [] : ['--build']),
  ],
  { env: composeEnv },
);
if (up.status !== 0) {
  const migrateLog = run('docker', ['logs', '--tail', '5', 'healthbridge-migrate-1'], {
    quiet: true,
  });
  if (/password authentication failed/.test(`${migrateLog.stdout}${migrateLog.stderr}`)) {
    fail(
      'The database rejected the passwords in this .env: the existing data was created with\n' +
        '  a different .env (another copy of the project, or a regenerated .env). Either copy\n' +
        '  the original .env back, or start fresh with  npm run reset  then  npm start.',
    );
  }
  fail('Some services did not become healthy. See `npm run logs` and RUNNING.md.');
}

// 4. Synthetic demo data (idempotent; only when DEMO_MODE=true).
if (env.DEMO_MODE === 'true' && !opts['no-seed']) {
  step('Loading synthetic demo data');
  const seed = run(
    'docker',
    ['compose', 'run', '--rm', '-T', 'migrate', 'node', 'scripts/seed-demo.js'],
    { quiet: true },
  );
  if (seed.status !== 0) {
    console.error(seed.stdout, seed.stderr);
    fail('Demo seeding failed.');
  }
}

// 5. Summary.
const port = (name, fallback) => env[name] || fallback;
const web = `http://localhost:${port('HOST_PORT_WEB', 8080)}`;
const lines = [
  ['HealthBridge', web],
  ['Emails (Mailpit)', `http://localhost:${port('HOST_PORT_MAILPIT_UI', 8025)}`],
  [
    'Job queues (Bull Board)',
    env.BULL_BOARD_PASSWORD
      ? `http://localhost:${port('BULL_BOARD_HOST_PORT', 3010)}  (user ops / BULL_BOARD_PASSWORD in .env)`
      : 'disabled (no BULL_BOARD_PASSWORD)',
  ],
  ...(opts.video
    ? [['Video (LiveKit)', `${env.LIVEKIT_URL || 'ws://localhost:7880'}  (live camera/mic)`]]
    : []),
  ...(opts.observability
    ? [
        [
          'Grafana',
          `http://localhost:${port('HOST_PORT_GRAFANA', 3001)}  (admin / GRAFANA_ADMIN_PASSWORD in .env)`,
        ],
        ['Prometheus', `http://localhost:${port('HOST_PORT_PROMETHEUS', 9090)}`],
      ]
    : []),
];
console.log('\n\x1b[32m✔ HealthBridge is running\x1b[0m\n');
for (const [k, v] of lines) console.log(`  ${k.padEnd(24)} ${v}`);
if (env.DEMO_MODE === 'true') {
  console.log(
    `\n  Synthetic demo accounts (password: DEMO_USER_PASSWORD in .env = ${env.DEMO_USER_PASSWORD})`,
  );
  for (const [who, email] of [
    ['Patient', 'patient.asha@demo.healthbridge.local'],
    ['Patient', 'patient.vikram@demo.healthbridge.local'],
    ['Doctor (verified)', 'dr.meera@demo.healthbridge.local'],
    ['Doctor (verified)', 'dr.rahul@demo.healthbridge.local'],
    ['Doctor (applicant)', 'dr.applicant@demo.healthbridge.local'],
    ['Clinic admin', 'clinic.admin@demo.healthbridge.local'],
    ['Platform admin', 'platform.admin@demo.healthbridge.local'],
    ['Support', 'support@demo.healthbridge.local'],
  ]) {
    console.log(`    ${who.padEnd(20)} ${email}`);
  }
}
console.log('\n  Stop: npm stop    ·    Logs: npm run logs    ·    Wipe all data: npm run reset\n');
