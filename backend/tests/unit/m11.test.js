import { describe, expect, it } from 'vitest';
import { basicAuthMatches } from '../../src/core/queue/bullBoard.js';
import { clientErrorSchema } from '../../src/modules/telemetry/routes.js';
import { loadConfig } from '../../src/config/index.js';
import { validEnv } from '../helpers.js';

const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

describe('Bull Board credentials', () => {
  const creds = { username: 'ops', password: 'a-long-board-password' };
  it('accepts only the exact username and password', () => {
    expect(basicAuthMatches(basic('ops', 'a-long-board-password'), creds)).toBe(true);
    expect(basicAuthMatches(basic('ops', 'a-long-board-passwor'), creds)).toBe(false);
    expect(basicAuthMatches(basic('admin', 'a-long-board-password'), creds)).toBe(false);
    // Passwords may contain colons; only the first one separates the username.
    expect(
      basicAuthMatches(basic('ops', 'pass:with:colons-123'), {
        ...creds,
        password: 'pass:with:colons-123',
      }),
    ).toBe(true);
    for (const header of [undefined, '', 'Bearer x', 'Basic', 'Basic !!!', basic('', '')]) {
      expect(basicAuthMatches(header, creds)).toBe(false);
    }
  });

  it('is disabled unless a password of 16+ characters is configured', () => {
    const base = validEnv;
    expect(() => loadConfig({ ...base, BULL_BOARD_PASSWORD: 'short' })).toThrow();
    const on = loadConfig({ ...base, BULL_BOARD_PASSWORD: 'x'.repeat(16) });
    expect(on.workers.bullBoard).toMatchObject({ enabled: true, port: 9466, username: 'ops' });
    const env = { ...base };
    delete env.BULL_BOARD_PASSWORD;
    expect(loadConfig(env).workers.bullBoard.enabled).toBe(false);
  });
});

describe('app URL for emailed links', () => {
  it('defaults to the first CORS origin and must be https outside development', () => {
    const dev = loadConfig({ ...validEnv, CORS_ORIGINS: 'http://localhost:8081' });
    expect(dev.http.publicAppUrl).toBe('http://localhost:8081');
    expect(() =>
      loadConfig({ ...validEnv, APP_ENV: 'staging', PUBLIC_APP_URL: 'http://staging.example' }),
    ).toThrow(/PUBLIC_APP_URL/);
    expect(() => loadConfig({ ...validEnv, PUBLIC_APP_URL: 'https://app.example/' })).toThrow();
  });
});

describe('client error reports', () => {
  it('keeps the error class and route template only', () => {
    const parsed = clientErrorSchema.parse({
      kind: 'render_error',
      name: 'RangeError',
      path: '/app/appointments/0192b6f0-a1b2-4c3d-8e5f-60718293a4c0/consultation',
    });
    expect(parsed).toEqual({
      kind: 'render_error',
      name: 'RangeError',
      path: '/app/appointments/:id/consultation',
    });
    expect(clientErrorSchema.parse({ kind: 'window_error', name: 'X', path: '/' }).name).toBe(
      'Other',
    );
    expect(
      clientErrorSchema.safeParse({ kind: 'window_error', name: 'Error', path: 'app' }).success,
    ).toBe(false);
  });
});

describe('managed-service TLS (M12)', () => {
  it('maps DB_SSL modes to node-postgres options and enables Redis TLS', async () => {
    const { pgSsl } = await import('../../src/core/db/ssl.js');
    expect(pgSsl()).toBe(false);
    expect(pgSsl({ mode: 'require' })).toEqual({ rejectUnauthorized: false });
    const pem = '-----BEGIN CERTIFICATE-----\nsynthetic\n-----END CERTIFICATE-----\n';
    expect(pgSsl({ mode: 'verify-full', caBase64: Buffer.from(pem).toString('base64') })).toEqual({
      rejectUnauthorized: true,
      ca: pem,
    });
    expect(() => pgSsl({ mode: 'prefer' })).toThrow();

    const config = loadConfig({ ...validEnv, DB_SSL: 'verify-full', REDIS_TLS: 'true' });
    expect(config.db.ssl).toBe('verify-full');
    expect(config.redis.tls).toBe(true);
    expect(loadConfig(validEnv).redis.tls).toBe(false);
    expect(() => loadConfig({ ...validEnv, DB_SSL: 'prefer' })).toThrow();

    const { bullConnection } = await import('../../src/core/queue/queues.js');
    expect(
      bullConnection({ host: 'cache.example', port: 6379, password: 'x', tls: true }).tls,
    ).toEqual({
      servername: 'cache.example',
    });
  });
});

describe('object storage credentials (M12)', () => {
  it('uses static keys for MinIO, or the AWS default credential chain when both are unset', async () => {
    const { createS3Client } = await import('../../src/core/storage/s3.js');
    const aws = { ...validEnv, S3_ENDPOINT: '', S3_ACCESS_KEY_ID: '', S3_SECRET_ACCESS_KEY: '' };
    const config = loadConfig(aws);
    expect(config.storage.accessKeyId).toBeUndefined();
    const client = createS3Client(config.storage);
    expect(client.config.credentials).toBeTypeOf('function'); // default provider chain
    client.destroy();

    expect(() => loadConfig({ ...aws, S3_ACCESS_KEY_ID: 'only-one' })).toThrow(/S3_SECRET/);
    expect(() => loadConfig({ ...aws, S3_ENDPOINT: 'http://minio:9000' })).toThrow(
      /S3_ACCESS_KEY_ID/,
    );
  });
});

describe('SMTP transport (M12)', () => {
  it('is plain only for local Mailpit and requires STARTTLS in staging/production', async () => {
    const { smtpTransportOptions } = await import('../../src/core/mail/smtp.js');
    expect(smtpTransportOptions({ smtpHost: 'mailpit', smtpPort: 1025 })).toMatchObject({
      ignoreTLS: true,
      secure: false,
    });
    const relay = smtpTransportOptions({
      smtpHost: 'email-smtp.ap-south-1.amazonaws.com',
      smtpPort: 587,
      requireTls: true,
      user: 'AKIASYNTHETIC',
      password: 'synthetic-secret',
    });
    expect(relay).toMatchObject({ requireTLS: true, auth: { user: 'AKIASYNTHETIC' } });
    expect(relay.ignoreTLS).toBeUndefined();
    // Even on port 1025, staging/production never fall back to plain SMTP.
    expect(smtpTransportOptions({ smtpHost: 'x', smtpPort: 1025, requireTls: true })).toMatchObject(
      { requireTLS: true },
    );

    const staging = loadConfig({
      ...validEnv,
      APP_ENV: 'staging',
      PUBLIC_APP_URL: 'https://staging.example',
      AUTH_COOKIE_SECURE: 'true',
      DOCUMENT_SCANNER: 'clamav',
      CLAMAV_HOST: 'clamav',
      CLINICAL_DATA_KEY: Buffer.alloc(32, 3).toString('base64'),
    });
    expect(staging.mail.requireTls).toBe(true);
    expect(() => loadConfig({ ...validEnv, SMTP_USER: 'only-user' })).toThrow(/SMTP_PASSWORD/);
  });
});
