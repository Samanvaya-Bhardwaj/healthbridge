import { CSRF_COOKIE, CSRF_HEADER } from '@healthbridge/shared';
import { ForbiddenError } from '../http/errors.js';
import { readCookies } from './cookies.js';

function requestOrigin(req) {
  const origin = req.get('origin');
  if (origin) return origin;
  const referer = req.get('referer');
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

/**
 * CSRF protection for cookie-authenticated endpoints (refresh, logout).
 *
 * Layers (ADR-0015):
 *   1. SameSite=Strict cookies (set elsewhere).
 *   2. Origin/Referer must be an allowed application origin.
 *   3. Double-submit: X-CSRF-Token header must equal the hb_csrf cookie.
 *   4. Synchronizer: the session service checks the token against the hash stored
 *      with the session, so a cookie planted by a sibling subdomain is not enough.
 *
 * @param {{ allowedOrigins: string[] }} options
 */
export function requireCsrf({ allowedOrigins }) {
  const allowed = new Set(allowedOrigins);
  return (req, _res, next) => {
    const origin = requestOrigin(req);
    if (!origin || !allowed.has(origin)) {
      return next(new ForbiddenError('Request origin is not allowed.', 'csrf_origin_rejected'));
    }
    const header = req.get(CSRF_HEADER);
    const cookie = readCookies(req)[CSRF_COOKIE];
    if (!header || !cookie || header !== cookie) {
      return next(new ForbiddenError('Missing or invalid CSRF token.', 'csrf_token_invalid'));
    }
    req.csrfToken = header;
    next();
  };
}
