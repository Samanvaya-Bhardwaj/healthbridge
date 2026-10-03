import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  checkTaskDefinition,
  renderAll,
  renderTemplate,
} from '../../../infra/deploy/ecs/render.mjs';

const ENV = {
  AWS_REGION: 'ap-south-1',
  AWS_ACCOUNT_ID: '123456789012',
  HB_ENV: 'staging',
  IMAGE_REGISTRY: '123456789012.dkr.ecr.ap-south-1.amazonaws.com',
  IMAGE_TAG: 'v1.0.0',
  DB_HOST: 'healthbridge.cluster-x.ap-south-1.rds.amazonaws.com',
  POSTGRES_DB: 'healthbridge',
  REDIS_HOST: 'master.healthbridge.x.aps1.cache.amazonaws.com',
  S3_BUCKET_DOCUMENTS: 'healthbridge-staging-documents',
  MAIL_FROM: 'HealthBridge <no-reply@example.test>',
  PUBLIC_APP_URL: 'https://staging.example.test',
  RAZORPAY_KEY_ID: 'rzp_test_synthetic',
  VIDEO_PROVIDER: 'mock',
  LIVEKIT_URL: 'wss://video.example.test',
  CLINICAL_DATA_KEY_ID: 'k1',
  LLM_PROVIDER: 'fake',
  LLM_EXTERNAL_PROCESSING_APPROVED: 'false',
};

describe('ECS task definitions (M12)', () => {
  it('render completely, with secrets only by reference', () => {
    const rendered = renderAll(ENV);
    expect(rendered.map((r) => r.file).sort()).toEqual([
      'ai-service.json',
      'api.json',
      'clamav.json',
      'migrate.json',
      'web.json',
      'worker.json',
    ]);
    for (const { def } of rendered) {
      expect(def.requiresCompatibilities).toEqual(['FARGATE']);
      expect(def.family).toMatch(/^healthbridge-staging-/);
      expect(JSON.stringify(def)).not.toMatch(/\$\{/);
      for (const c of def.containerDefinitions) {
        for (const s of c.secrets ?? []) {
          expect(s.valueFrom).toMatch(
            /^arn:aws:secretsmanager:ap-south-1:123456789012:secret:healthbridge\/staging:[A-Z0-9_]+::$/,
          );
        }
      }
    }
    const api = rendered.find((r) => r.file === 'api.json').def.containerDefinitions[0];
    const envOf = Object.fromEntries(api.environment.map((e) => [e.name, e.value]));
    expect(envOf).toMatchObject({
      APP_ENV: 'staging',
      DB_SSL: 'verify-full',
      REDIS_TLS: 'true',
      AUTH_COOKIE_SECURE: 'true',
      DOCUMENT_SCANNER: 'clamav',
      DEMO_MODE: 'false',
    });
    expect(api.readonlyRootFilesystem).toBe(true);
    expect(api.image).toBe(`${ENV.IMAGE_REGISTRY}/healthbridge-backend:v1.0.0`);
  });

  it('refuse missing values and plain-text secrets', () => {
    const { IMAGE_TAG: _omit, ...partial } = ENV;
    expect(() => renderAll(partial)).toThrow(/missing values: IMAGE_TAG/);
    const leaky = {
      containerDefinitions: [
        {
          name: 'x',
          image: 'r/x:v1',
          environment: [{ name: 'DB_APP_PASSWORD', value: 'oops' }],
          logConfiguration: {},
          healthCheck: {},
        },
      ],
    };
    expect(checkTaskDefinition(leaky)).toEqual(['x: DB_APP_PASSWORD must be a secret']);
    expect(renderTemplate('{"a":"${X}"}', { X: 'say "hi"' })).toEqual({ a: 'say "hi"' });
  });

  it('the production compose file pins images to a release and keeps data services private', () => {
    const compose = readFileSync(
      new URL('../../../infra/deploy/compose.prod.yml', import.meta.url),
      'utf8',
    );
    expect(compose).toContain('HB_VERSION:?');
    expect(compose).not.toMatch(/:latest\b/);
    // Only the web container publishes public ports; the board is loopback-only.
    const published = compose.match(/^\s+- '[^']*:\d+'$/gm) ?? [];
    expect(published.map((p) => p.trim())).toEqual([
      "- '127.0.0.1:${BULL_BOARD_HOST_PORT:-3010}:9466'",
      "- '${HB_HTTP_PORT:-80}:8080'",
      "- '${HB_HTTPS_PORT:-443}:8443'",
    ]);
  });
});
