import { resetLocalRateLimits } from './rateLimits.js';

/**
 * The journeys register accounts and request reset links, which the API rate-limits per
 * IP (by design), and every page load counts against the per-IP API limit. Before a run
 * against the local Compose stack, clear those counters so repeated runs are
 * deterministic. Never used against shared environments (E2E_BASE_URL set) — there the
 * limits must stay intact.
 */
export default function globalSetup() {
  resetLocalRateLimits(['auth-', 'api-global']);
}
