/**
 * PostgreSQL TLS for managed databases (ADR-0028), shared by the runtime pool and
 * migrations.
 *   disable      no TLS (single-host Compose: private Docker network on one machine)
 *   require      encrypted, server identity NOT verified (transitional only)
 *   verify-full  encrypted and verified against DB_SSL_CA (base64 PEM bundle, e.g. the
 *                RDS global bundle) or the system trust store
 * @param {{ mode?: string, caBase64?: string }} options
 * @returns {false | import('node:tls').ConnectionOptions}
 */
export function pgSsl({ mode = 'disable', caBase64 } = {}) {
  if (mode === 'disable') return false;
  if (mode === 'require') return { rejectUnauthorized: false };
  if (mode === 'verify-full') {
    return {
      rejectUnauthorized: true,
      ...(caBase64 ? { ca: Buffer.from(caBase64, 'base64').toString('utf8') } : {}),
    };
  }
  throw new Error(`Unsupported DB_SSL mode: ${mode}`);
}
