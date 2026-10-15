import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Clears the API's rate-limit counters on the local Compose stack, so a run (or a heavy
 * suite such as the accessibility scans, which load dozens of pages from one IP) does not
 * leave the next journeys throttled. Never against shared environments (E2E_BASE_URL set):
 * there the limits must stay intact.
 *
 * @param {string[]} prefixes counter key prefixes, e.g. ['auth-', 'api-global']
 */
export function resetLocalRateLimits(prefixes) {
  if (process.env.E2E_BASE_URL) return;
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  const script = prefixes
    .map(
      (prefix) =>
        `redis-cli -a "$REDIS_PASSWORD" --no-auth-warning --scan --pattern "rl:${prefix}*" ` +
        '| xargs -r redis-cli -a "$REDIS_PASSWORD" --no-auth-warning del >/dev/null',
    )
    .join('; ');
  try {
    execFileSync('docker', ['compose', 'exec', '-T', 'redis', 'sh', '-c', script], {
      cwd,
      stdio: 'ignore',
    });
  } catch {
    console.warn('e2e: could not reset local rate limits (is the Compose stack running?)');
  }
}
