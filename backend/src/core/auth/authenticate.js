import { UnauthorizedError } from '../http/errors.js';
import { TokenError } from './tokens.js';

const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;

/**
 * Authenticates the request from a Bearer access token and attaches `req.principal`.
 *
 * Authentication is always decided server-side: the token signature/expiry is checked,
 * then the session, account status, roles and permissions are loaded from the database,
 * so logout, revocation, disabling and role changes apply to the very next request.
 *
 * @param {{
 *   tokenService: ReturnType<typeof import('./tokens.js').createTokenService>,
 *   resolvePrincipal: (claims: { userId: string, sessionId: string }, req: import('express').Request) => Promise<import('../authz/principal.js').Principal | null>,
 * }} deps
 */
export function createAuthenticate({ tokenService, resolvePrincipal }) {
  return function authenticate() {
    return async (req, _res, next) => {
      const header = req.get('authorization');
      if (!header) return next(new UnauthorizedError('Authentication is required.'));

      const match = BEARER.exec(header);
      if (!match)
        return next(new UnauthorizedError('Malformed authorization header.', 'token_invalid'));

      let claims;
      try {
        claims = await tokenService.verifyAccessToken(match[1]);
      } catch (err) {
        if (err instanceof TokenError) {
          return next(
            new UnauthorizedError(
              err.code === 'token_expired' ? 'Access token expired.' : 'Access token invalid.',
              err.code,
            ),
          );
        }
        return next(err);
      }

      const principal = await resolvePrincipal(claims, req);
      if (!principal) {
        return next(new UnauthorizedError('Session is no longer valid.', 'session_invalid'));
      }
      req.principal = principal;
      next();
    };
  };
}
