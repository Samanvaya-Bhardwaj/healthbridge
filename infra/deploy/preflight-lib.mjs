// Step 12: pure checks behind infra/deploy/preflight.mjs (unit-tested). They read the
// final per-service environment that `docker compose config` renders and report variable
// NAMES only, never values.

/** Secrets that must all be different from each other. */
const SECRETS = [
  'POSTGRES_PASSWORD',
  'DB_APP_PASSWORD',
  'DB_AI_PASSWORD',
  'REDIS_PASSWORD',
  'MINIO_ROOT_PASSWORD',
  'INTERNAL_SERVICE_SECRET',
  'PAYMENT_WEBHOOK_SECRET',
  'CLINICAL_DATA_KEY',
  'AI_INPUT_DIGEST_KEY',
  'BACKUP_OBJECTS_PASSWORD',
  'BULL_BOARD_PASSWORD',
];

const fail = (check, detail) => ({ level: 'FAIL', check, detail });
const warn = (check, detail) => ({ level: 'WARN', check, detail });
const pass = (check, detail = '') => ({ level: 'PASS', check, detail });

/**
 * @param {Record<string, Record<string, string>>} services environment by service name
 * @returns {{ level: 'PASS'|'WARN'|'FAIL', check: string, detail: string }[]}
 */
export function policyFindings(services) {
  const out = [];
  const api = services.api ?? {};
  const ai = services['ai-service'] ?? {};
  const env = api.APP_ENV;

  if (!['staging', 'production'].includes(env)) {
    out.push(fail('APP_ENV', 'must be staging or production for this deployment'));
    return out;
  }
  out.push(pass('APP_ENV', env));

  if (api.DEMO_MODE === 'true') {
    out.push(
      env === 'production'
        ? fail('DEMO_MODE', 'demo data is never allowed in production')
        : warn('DEMO_MODE', 'synthetic demo data will be seeded'),
    );
  }
  if (!/^https:\/\//.test(api.PUBLIC_APP_URL ?? '')) {
    out.push(fail('PUBLIC_APP_URL', 'must be an https:// URL'));
  }

  // ── External AI processing (ADR-0008, ADR-0036) ─────────────────────────────────────
  const provider = ai.LLM_PROVIDER ?? 'fake';
  const approved = ai.LLM_EXTERNAL_PROCESSING_APPROVED === 'true';
  if (provider === 'fake') {
    out.push(
      env === 'production'
        ? fail(
            'LLM_PROVIDER',
            'the AI service refuses the fake model in production. Deploying needs an explicit ' +
              'decision: approve external processing (LLM_PROVIDER=claude, ANTHROPIC_API_KEY, ' +
              'LLM_EXTERNAL_PROCESSING_APPROVED=true, LLM_DAILY_BUDGET_USD) after the ADR-0008 review',
          )
        : warn('LLM_PROVIDER', 'fake model: AI features use the offline stand-in'),
    );
  } else {
    if (env === 'production' && !approved) {
      out.push(
        fail('LLM_EXTERNAL_PROCESSING_APPROVED', 'an external model in production needs approval'),
      );
    } else if (approved) {
      out.push(warn('LLM_EXTERNAL_PROCESSING_APPROVED', 'external processing is approved'));
    }
    if (!ai.ANTHROPIC_API_KEY)
      out.push(fail('ANTHROPIC_API_KEY', 'required with LLM_PROVIDER=claude'));
    const budget = Number(ai.LLM_DAILY_BUDGET_USD);
    if (!(budget > 0)) {
      out.push(fail('LLM_DAILY_BUDGET_USD', 'a positive daily ceiling is required'));
    } else {
      out.push(pass('LLM_DAILY_BUDGET_USD', `ceiling set (${budget} USD a day)`));
    }
  }
  if ((ai.EMBEDDING_PROVIDER ?? 'hashing') !== 'hashing' && env === 'production' && !approved) {
    out.push(fail('EMBEDDING_PROVIDER', 'external embeddings in production need approval'));
  }

  // ── Secrets: present and distinct ───────────────────────────────────────────────────
  const all = Object.assign({}, ...Object.values(services));
  const byValue = new Map();
  for (const name of SECRETS) {
    const value = all[name];
    if (!value) continue;
    byValue.set(value, [...(byValue.get(value) ?? []), name]);
  }
  for (const names of byValue.values()) {
    if (names.length > 1) {
      out.push(fail('secret reuse', `${names.join(' and ')} have the same value`));
    }
  }
  if (!all.BACKUP_REMOTE) {
    out.push(warn('BACKUP_REMOTE', 'backups stay on this host only; set an off-site remote'));
  }
  return out;
}
