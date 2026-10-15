#!/usr/bin/env node
// Step 9: recomputes the whole audit seal chain (ADR-0035) and exits non-zero if any
// sealed range of the audit log changed, a seal is missing or altered, or a key is gone.
//
//   npm run audit:verify -w backend            # the whole chain
//   npm run audit:verify -w backend -- --latest 96   # the most recent seals only
//
// Prints one JSON line: no audit content, only counts, seal numbers and time ranges.

import { createScriptRuntime, parseArgs } from './lib/runtime.js';

const args = parseArgs();
const latest = args.latest ? Number(args.latest) : undefined;
if (latest !== undefined && !(Number.isInteger(latest) && latest > 0)) {
  console.error('Usage: verify-audit [--latest <number of seals>]');
  process.exit(2);
}

const runtime = createScriptRuntime('verify-audit');
try {
  const result = await runtime.container.auditSealer.verify({ latest });
  console.log(JSON.stringify({ msg: 'audit seal verification', ...result }));
  if (result.status === 'failed') process.exitCode = 1;
} catch (err) {
  console.error(JSON.stringify({ level: 'fatal', msg: 'verify-audit failed', error: err.message }));
  process.exitCode = 1;
} finally {
  await runtime.close();
}
