import pino from 'pino';

/**
 * Paths that must never reach log output. Medical content is not logged at all;
 * this list is a safety net for credentials and tokens that may appear in
 * headers or error objects.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-internal-token"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.secret',
  '*.apiKey',
];

/**
 * @param {{ level: string, service?: string, appEnv?: string, destination?: import('pino').DestinationStream }} options
 */
export function createLogger({ level, service = 'healthbridge-api', appEnv, destination }) {
  return pino(
    {
      level,
      base: { service, env: appEnv },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      formatters: { level: (label) => ({ level: label }) },
    },
    destination,
  );
}
