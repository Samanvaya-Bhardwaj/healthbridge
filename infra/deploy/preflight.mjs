#!/usr/bin/env node
// Step 12: deployment preflight for the single-host stack (infra/deploy/compose.prod.yml).
// Run it on the server, or wherever the environment file lives, before every release:
//
//   node infra/deploy/preflight.mjs --env-file /etc/healthbridge/healthbridge.env \
//     --backend-image ghcr.io/<owner>/healthbridge-backend:v1.2.3 \
//     --ai-image ghcr.io/<owner>/healthbridge-ai:v1.2.3
//
// It needs Node and Docker. The service checks run inside the release images (the env
// is passed on stdin, never as arguments). Without --backend-image, a repository
// checkout's backend is used instead.
//
// It renders every service's final environment with `docker compose config`, so each
// required variable is checked exactly as Compose will see it. It then validates:
//   - the API, worker and migrate environments with the backend's own configuration
//     rules (the same checks the services run at start-up);
//   - the AI service's settings inside its image (optional: --ai-image);
//   - deployment policy: external AI approval and spend ceiling, HTTPS, distinct secrets,
//     off-site backups.
// Output names variables and rules only, never values. It exits with 1 on any FAIL.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { policyFindings } from './preflight-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({
  options: {
    'env-file': { type: 'string' },
    'backend-image': { type: 'string' },
    'ai-image': { type: 'string' },
  },
});
if (!args['env-file']) {
  console.error(
    'Usage: preflight --env-file <path> [--backend-image <image>] [--ai-image <image>]',
  );
  process.exit(2);
}

const findings = [];
const add = (level, check, detail = '') => findings.push({ level, check, detail });

// ── 1. Render the deployment as Compose will run it ───────────────────────────────────
const rendered = spawnSync(
  'docker',
  [
    'compose',
    '-f',
    join(here, 'compose.prod.yml'),
    '--env-file',
    args['env-file'],
    'config',
    '--format',
    'json',
  ],
  { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
);
if (rendered.status !== 0) {
  // Compose names the missing variable; it does not print values.
  add('FAIL', 'compose config', rendered.stderr.trim().split('\n').slice(-3).join(' '));
  report();
}
const services = Object.fromEntries(
  Object.entries(JSON.parse(rendered.stdout).services).map(([name, s]) => [
    name,
    Object.fromEntries(
      Object.entries(s.environment ?? {}).map(([k, v]) => [k, v === null ? '' : String(v)]),
    ),
  ]),
);
add('PASS', 'compose config', `${Object.keys(services).length} services rendered`);

// ── 2. Backend configuration rules (API, worker, migrate) ─────────────────────────────
/** Runs a validation script inside an image; the environment arrives on stdin. */
function inImage(image, entrypoint, script, env) {
  return spawnSync(
    'docker',
    ['run', '--rm', '-i', '--network', 'none', '--entrypoint', entrypoint, image, '-e', script],
    { input: JSON.stringify(env), encoding: 'utf8' },
  );
}
const BACKEND_CHECK = [
  "const env = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));",
  "import('/app/backend/src/config/index.js').then(({ loadConfig, ConfigError }) => {",
  '  try { loadConfig(env); console.log("ok"); }',
  '  catch (err) {',
  '    if (!(err instanceof ConfigError)) { console.log("(config) | could not validate"); process.exit(1); }',
  '    for (const i of err.issues) console.log(`${i.variable} | ${i.message}`);',
  '    process.exit(1);',
  '  }',
  '});',
].join('\n');
const localBackend = new URL('../../backend/src/config/index.js', import.meta.url);
const local =
  !args['backend-image'] && existsSync(fileURLToPath(localBackend))
    ? await import(localBackend.href)
    : null;
for (const name of ['api', 'worker', 'migrate']) {
  if (!services[name]) continue;
  if (local) {
    try {
      local.loadConfig(services[name]);
      add('PASS', `${name} configuration`);
    } catch (err) {
      if (!(err instanceof local.ConfigError)) throw err;
      for (const issue of err.issues) add('FAIL', `${name}: ${issue.variable}`, issue.message);
    }
  } else if (args['backend-image']) {
    const r = inImage(args['backend-image'], 'node', BACKEND_CHECK, services[name]);
    if (r.status === 0) add('PASS', `${name} configuration`);
    else if (r.stdout.trim()) {
      for (const line of r.stdout.trim().split('\n')) {
        const [variable, message] = line.split(' | ');
        add('FAIL', `${name}: ${variable}`, message ?? '');
      }
    } else add('FAIL', `${name} configuration`, 'could not run the backend image');
  } else {
    add('WARN', `${name} configuration`, 'not checked (pass --backend-image to validate it)');
  }
}

// ── 3. AI service settings, validated by the AI service itself ────────────────────────
if (args['ai-image'] && services['ai-service']) {
  const script = [
    'import json, os, sys',
    'os.environ.update(json.load(sys.stdin))',
    'from pydantic import ValidationError',
    'from app.core.config import Settings',
    'try:',
    '    Settings()',
    '    print("ok")',
    'except ValidationError as e:',
    '    for err in e.errors(include_input=False, include_url=False):',
    '        print(".".join(str(p) for p in err["loc"]) or "settings", "|", err["msg"])',
    '    sys.exit(1)',
  ].join('\n');
  const ai = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '-i',
      '--network',
      'none',
      '--entrypoint',
      'python',
      args['ai-image'],
      '-c',
      script,
    ],
    { input: JSON.stringify(services['ai-service']), encoding: 'utf8' },
  );
  if (ai.status === 0) add('PASS', 'ai-service configuration');
  else if (ai.stdout.trim()) {
    for (const line of ai.stdout.trim().split('\n')) {
      const [field, message] = line.split(' | ');
      add('FAIL', `ai-service: ${field}`, message ?? '');
    }
  } else add('FAIL', 'ai-service configuration', 'could not run the AI image');
} else {
  add('WARN', 'ai-service configuration', 'not checked (pass --ai-image to validate it)');
}

// ── 4. Deployment policy ─────────────────────────────────────────────────────────────
findings.push(...policyFindings(services));
report();

function report() {
  const order = { FAIL: 0, WARN: 1, PASS: 2 };
  for (const f of [...findings].sort((a, b) => order[a.level] - order[b.level])) {
    console.log(`${f.level.padEnd(4)}  ${f.check}${f.detail ? ` — ${f.detail}` : ''}`);
  }
  const failed = findings.filter((f) => f.level === 'FAIL').length;
  console.log(failed ? `\n${failed} check(s) failed.` : '\nPreflight passed.');
  process.exit(failed ? 1 : 0);
}
