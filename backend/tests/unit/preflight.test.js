import { describe, expect, it } from 'vitest';
import { policyFindings } from '../../../infra/deploy/preflight-lib.mjs';

/** Step 12: deployment policy checks of infra/deploy/preflight.mjs (names, never values). */
const base = (overrides = {}) => ({
  api: {
    APP_ENV: 'production',
    PUBLIC_APP_URL: 'https://health.example.org',
    DEMO_MODE: 'false',
    INTERNAL_SERVICE_SECRET: 'a'.repeat(48),
    PAYMENT_WEBHOOK_SECRET: 'b'.repeat(32),
    CLINICAL_DATA_KEY: 'c'.repeat(44),
    AI_INPUT_DIGEST_KEY: 'd'.repeat(44),
    ...overrides.api,
  },
  'ai-service': {
    LLM_PROVIDER: 'claude',
    ANTHROPIC_API_KEY: 'sk-synthetic',
    LLM_EXTERNAL_PROCESSING_APPROVED: 'true',
    LLM_DAILY_BUDGET_USD: '20',
    ...overrides.ai,
  },
  backup: { BACKUP_REMOTE: 'offsite:healthbridge', ...overrides.backup },
});
const failed = (findings) => findings.filter((f) => f.level === 'FAIL').map((f) => f.check);

describe('deployment preflight policy (step 12)', () => {
  it('passes an approved production setup with a spend ceiling', () => {
    const findings = policyFindings(base());
    expect(failed(findings)).toEqual([]);
    expect(findings).toContainEqual(
      expect.objectContaining({ level: 'WARN', check: 'LLM_EXTERNAL_PROCESSING_APPROVED' }),
    );
  });

  it('blocks production without an explicit external-AI decision', () => {
    expect(failed(policyFindings(base({ ai: { LLM_PROVIDER: 'fake' } })))).toEqual([
      'LLM_PROVIDER',
    ]);
    expect(
      failed(policyFindings(base({ ai: { LLM_EXTERNAL_PROCESSING_APPROVED: 'false' } }))),
    ).toEqual(['LLM_EXTERNAL_PROCESSING_APPROVED']);
    expect(failed(policyFindings(base({ ai: { LLM_DAILY_BUDGET_USD: '' } })))).toEqual([
      'LLM_DAILY_BUDGET_USD',
    ]);
  });

  it('allows the fake model in staging, with a warning', () => {
    const findings = policyFindings(
      base({ api: { APP_ENV: 'staging' }, ai: { LLM_PROVIDER: 'fake' } }),
    );
    expect(failed(findings)).toEqual([]);
    expect(findings).toContainEqual(
      expect.objectContaining({ level: 'WARN', check: 'LLM_PROVIDER' }),
    );
  });

  it('refuses demo data, plain http and reused secrets; never prints values', () => {
    const findings = policyFindings(
      base({
        api: {
          DEMO_MODE: 'true',
          PUBLIC_APP_URL: 'http://health.example.org',
          PAYMENT_WEBHOOK_SECRET: 'a'.repeat(48), // same as INTERNAL_SERVICE_SECRET
        },
      }),
    );
    expect(failed(findings).sort()).toEqual(['DEMO_MODE', 'PUBLIC_APP_URL', 'secret reuse']);
    const text = JSON.stringify(findings);
    expect(text).toContain('INTERNAL_SERVICE_SECRET and PAYMENT_WEBHOOK_SECRET');
    expect(text).not.toContain('a'.repeat(48));
    expect(text).not.toContain('sk-synthetic');
  });

  it('warns when backups stay on the host', () => {
    const findings = policyFindings(base({ backup: { BACKUP_REMOTE: '' } }));
    expect(findings).toContainEqual(
      expect.objectContaining({ level: 'WARN', check: 'BACKUP_REMOTE' }),
    );
  });
});
