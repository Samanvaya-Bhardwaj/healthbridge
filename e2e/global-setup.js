import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * The journeys register accounts and request reset links, which the API rate-limits per
 * IP (by design). Before a run against the local Compose stack, clear those counters so
 * repeated runs are deterministic. Never used against shared environments
 * (E2E_BASE_URL set) — there the limits must stay intact.
 */
export default function globalSetup() {
  if (process.env.E2E_BASE_URL) return;
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  const script =
    'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning --scan --pattern "rl:auth-*" ' +
    '| xargs -r redis-cli -a "$REDIS_PASSWORD" --no-auth-warning del >/dev/null';
  try {
    execFileSync('docker', ['compose', 'exec', '-T', 'redis', 'sh', '-c', script], {
      cwd,
      stdio: 'ignore',
    });
  } catch {
    console.warn('e2e: could not reset local rate limits (is the Compose stack running?)');
  }
}
