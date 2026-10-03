#!/usr/bin/env node
// Renders the ECS task-definition templates in this directory (ADR-0028).
//
//   node infra/deploy/ecs/render.mjs <out-dir>
//
// Every ${NAME} placeholder must be provided by the environment (no silent blanks).
// Secrets are never rendered: templates reference AWS Secrets Manager by ARN, and the
// renderer refuses a template that puts a secret-looking variable in plain `environment`.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SECRET_NAME = /(PASSWORD|SECRET|PRIVATE_KEY|API_KEY|_CA)$/;

export function renderTemplate(text, env) {
  const missing = new Set();
  const rendered = text.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => {
    if (env[name] === undefined || env[name] === '') missing.add(name);
    return JSON.stringify(String(env[name] ?? '')).slice(1, -1);
  });
  if (missing.size) throw new Error(`missing values: ${[...missing].sort().join(', ')}`);
  return JSON.parse(rendered);
}

export function checkTaskDefinition(def) {
  const problems = [];
  // One-off tasks (migrations) exit when done; long-running services need health checks.
  const oneOff = /-migrate$/.test(def.family ?? '');
  for (const c of def.containerDefinitions) {
    for (const { name } of c.environment ?? []) {
      if (SECRET_NAME.test(name)) problems.push(`${c.name}: ${name} must be a secret`);
    }
    if (!c.logConfiguration) problems.push(`${c.name}: no log configuration`);
    if (!c.healthCheck && !oneOff) problems.push(`${c.name}: no health check`);
    if (/:latest$|:\$|:$/.test(c.image)) problems.push(`${c.name}: image must be pinned`);
  }
  return problems;
}

export function renderAll(env, templates = here) {
  return readdirSync(templates)
    .filter((f) => f.endsWith('.json'))
    .map((file) => {
      const def = renderTemplate(readFileSync(join(templates, file), 'utf8'), env);
      const problems = checkTaskDefinition(def);
      if (problems.length) throw new Error(`${file}: ${problems.join('; ')}`);
      return { file, def };
    });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error('usage: render.mjs <out-dir>');
    process.exit(2);
  }
  mkdirSync(outDir, { recursive: true });
  for (const { file, def } of renderAll(process.env)) {
    writeFileSync(join(outDir, file), `${JSON.stringify(def, null, 2)}\n`);
    console.log(`rendered ${file} → ${def.family}`);
  }
}
