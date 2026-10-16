#!/usr/bin/env node
// Part 4: give existing document chunks vectors of the current embedding model (ADR-0037),
// e.g. after switching EMBEDDING_PROVIDER to ollama. The worker also does this once at
// every start; run it by hand to do it now. Prints one JSON line (counts only).
//
//   npm run records:reembed -w backend

import { createScriptRuntime } from './lib/runtime.js';

const runtime = createScriptRuntime('reembed-records');
try {
  const result = await runtime.container.intelligenceService.reembedAll();
  console.log(JSON.stringify({ msg: 'document chunks re-embedded', ...result }));
} catch (err) {
  console.error(JSON.stringify({ level: 'fatal', msg: 'reembed failed', error: err.message }));
  process.exitCode = 1;
} finally {
  await runtime.close();
}
