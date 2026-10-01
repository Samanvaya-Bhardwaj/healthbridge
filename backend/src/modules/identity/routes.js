import { Router } from 'express';
import { z } from 'zod';
import {
  PERMISSIONS,
  changePasswordSchema,
  loginSchema,
  registerSchema,
  updateAccountSchema,
} from '@healthbridge/shared';
import { validate } from '../../core/http/validate.js';
import { rateLimit } from '../../core/http/rateLimit.js';
import { requireCsrf } from '../../core/auth/csrf.js';
import {
  REFRESH_COOKIE,
  clearSessionCookies,
  readCookies,
  setSessionCookies,
} from '../../core/auth/cookies.js';
import { sha256Hex } from '../../core/auth/secrets.js';
import { principalView } from '../../core/authz/principal.js';
import { UnauthorizedError } from '../../core/http/errors.js';

const REGISTRATION_ACCEPTED_MESSAGE =
  'Thanks. If this email can be used for a new account, you can now sign in. ' +
  'If you already have an account, sign in or check your email.';

/**
 * /auth/* and /users/me/* routes.
 * @param {ReturnType<typeof import('../../container.js').createContainer>} container
 */
export function identityRoutes(container) {
  const { config, redis, authService, accountService, accessPolicy, authenticate, rateLimits } =
    container;
  const router = Router();
  const cookieSecure = config.auth.cookieSecure;
  const csrf = requireCsrf({ allowedOrigins: config.http.corsOrigins });
  const limiter = (name, key) =>
    rateLimit({ redis, keyPrefix: `auth-${name}`, ...rateLimits[name], key });

  function sessionResponse(res, result) {
    setSessionCookies(res, {
      refreshToken: result.refreshToken,
      csrfToken: result.csrfToken,
      maxAgeSeconds: (result.sessionExpiresAt.getTime() - Date.now()) / 1000,
      secure: cookieSecure,
    });
    // Tokens and session state must never be cached by browsers or proxies.
    res.set('Cache-Control', 'no-store');
    res.json({
      data: {
        accessToken: result.accessToken.token,
        tokenType: 'Bearer',
        expiresIn: result.accessToken.expiresIn,
        sessionExpiresAt: result.sessionExpiresAt,
        user: result.user,
      },
    });
  }

  // ── Public ─────────────────────────────────────────────────────────

  router.post(
    '/auth/register',
    limiter('register'),
    validate({ body: registerSchema }),
    async (req, res) => {
      await authService.register(req.valid.body, req);
      res
        .status(202)
        .json({ data: { status: 'received', message: REGISTRATION_ACCEPTED_MESSAGE } });
    },
  );

  router.post(
    '/auth/login',
    limiter('loginIp'),
    validate({ body: loginSchema }),
    // Per-account limit keyed by a hash so raw emails never appear in Redis keys.
    limiter('loginAccount', (req) => sha256Hex(req.valid.body.email)),
    async (req, res) => {
      const result = await authService.login(req.valid.body, req);
      sessionResponse(res, result);
    },
  );

  router.post('/auth/refresh', limiter('refresh'), csrf, async (req, res) => {
    try {
      const result = await authService.refresh(
        { refreshToken: readCookies(req)[REFRESH_COOKIE], csrfToken: req.csrfToken },
        req,
      );
      sessionResponse(res, result);
    } catch (err) {
      if (err instanceof UnauthorizedError && err.code === 'session_invalid') {
        clearSessionCookies(res, { secure: cookieSecure });
      }
      throw err;
    }
  });

  router.post('/auth/logout', limiter('refresh'), csrf, async (req, res) => {
    await authService.logout({ refreshToken: readCookies(req)[REFRESH_COOKIE] }, req);
    clearSessionCookies(res, { secure: cookieSecure });
    res.status(204).end();
  });

  // ── Authenticated ──────────────────────────────────────────────────

  router.get('/auth/me', authenticate(), (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ data: principalView(req.principal) });
  });

  router.get(
    '/auth/sessions',
    authenticate(),
    accessPolicy.requirePermission(PERMISSIONS.SESSIONS_READ),
    async (req, res) => {
      res.json({ data: await accountService.listSessions(req.principal) });
    },
  );

  router.delete(
    '/auth/sessions/:sessionId',
    authenticate(),
    accessPolicy.requirePermission(PERMISSIONS.SESSIONS_REVOKE),
    validate({ params: z.object({ sessionId: z.string().max(64) }) }),
    async (req, res) => {
      await accountService.revokeSession(req.principal, req.valid.params.sessionId, req);
      res.status(204).end();
    },
  );

  router.post(
    '/auth/sessions/revoke-others',
    authenticate(),
    accessPolicy.requirePermission(PERMISSIONS.SESSIONS_REVOKE),
    async (req, res) => {
      res.json({ data: await accountService.revokeOtherSessions(req.principal, req) });
    },
  );

  router.get(
    '/users/me',
    authenticate(),
    accessPolicy.requirePermission(PERMISSIONS.ACCOUNT_READ),
    async (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.json({ data: await accountService.getAccount(req.principal) });
    },
  );

  router.patch(
    '/users/me',
    authenticate(),
    accessPolicy.requirePermission(PERMISSIONS.ACCOUNT_UPDATE),
    validate({ body: updateAccountSchema }),
    async (req, res) => {
      res.json({ data: await accountService.updateProfile(req.principal, req.valid.body, req) });
    },
  );

  router.post(
    '/users/me/password',
    authenticate(),
    accessPolicy.requirePermission(PERMISSIONS.ACCOUNT_UPDATE),
    limiter('passwordChange', (req) => req.principal.userId),
    validate({ body: changePasswordSchema }),
    async (req, res) => {
      res.json({ data: await accountService.changePassword(req.principal, req.valid.body, req) });
    },
  );

  return router;
}
