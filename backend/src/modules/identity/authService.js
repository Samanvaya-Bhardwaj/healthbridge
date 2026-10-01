import { CURRENT_TERMS_VERSION, ROLES } from '@healthbridge/shared';
import { newId } from '../../core/db/ids.js';
import { generateSecret, safeEqualHex, sha256Hex } from '../../core/auth/secrets.js';
import { ForbiddenError, UnauthorizedError, ValidationError } from '../../core/http/errors.js';
import { checkPasswordPolicy } from './domain/passwordPolicy.js';
import { composeRefreshToken, parseRefreshToken } from './domain/refreshToken.js';
import {
  LOCKOUT,
  REFRESH_REUSE_GRACE_SECONDS,
  REVOKE_REASONS,
  isSessionExpired,
  nextIdleExpiry,
  sessionLifetimeFor,
} from './domain/sessionPolicy.js';

const AUTH = 'authentication';
const PG_UNIQUE_VIOLATION = '23505';
const MAX_USER_AGENT = 512;

const invalidCredentials = () =>
  new UnauthorizedError('Invalid email or password.', 'invalid_credentials');
const sessionInvalid = () =>
  new UnauthorizedError('Your session has ended. Please sign in again.', 'session_invalid');

const clientIp = (req) => {
  const ip = req?.ip?.replace(/^::ffff:/, '');
  return ip || null;
};

/**
 * Authentication use cases: registration, login, refresh (rotation + reuse detection),
 * logout, and per-request principal resolution (ADR-0015).
 */
export function createAuthService({
  knex,
  users,
  roles,
  sessions,
  hasher,
  tokens,
  audit,
  mailer,
  logger,
  sessionLifetimes,
  now = () => new Date(),
}) {
  // ── Registration ──────────────────────────────────────────────────────

  /**
   * Enumeration-resistant: the caller receives the same response whether or not the
   * email is already registered. An existing account owner is notified by email instead.
   * Both paths perform a full password hash so timing does not reveal the difference.
   */
  async function register({ email, password, fullName }, req) {
    const policyError = checkPasswordPolicy(password, { email, fullName });
    if (policyError) throw new ValidationError([{ path: 'body.password', message: policyError }]);

    const passwordHash = await hasher.hash(password);
    const userId = newId();

    let created;
    try {
      created = await knex.transaction(async (trx) => {
        if (await users.emailExists(email, trx)) return false;
        await users.insert(
          {
            id: userId,
            email,
            full_name: fullName,
            password_hash: passwordHash,
            terms_accepted_at: now(),
            terms_version: CURRENT_TERMS_VERSION,
          },
          trx,
        );
        await roles.grant(userId, ROLES.PATIENT, null, trx);
        await audit.record(
          {
            category: AUTH,
            action: 'auth.register',
            outcome: 'success',
            actor: { userId, roles: [ROLES.PATIENT] },
            resourceType: 'user',
            resourceId: userId,
            metadata: { termsVersion: CURRENT_TERMS_VERSION },
          },
          { req, trx },
        );
        return true;
      });
    } catch (err) {
      if (err.code !== PG_UNIQUE_VIOLATION) throw err;
      created = false; // concurrent registration with the same email
    }

    if (!created) {
      await audit.recordBestEffort(
        {
          category: AUTH,
          action: 'auth.register',
          outcome: 'failure',
          actor: null,
          reason: 'email_in_use',
        },
        { req },
      );
      // After the response path: delivery time must not be observable by the caller.
      setImmediate(() => {
        mailer
          .send({
            template: 'registration_attempt_existing_account',
            to: email,
            subject: 'Someone tried to create a HealthBridge account with your email',
            text:
              'Someone tried to create a new HealthBridge account using this email address.\n\n' +
              'If this was you, you already have an account: sign in instead.\n' +
              'If it was not you, no action is needed. Your account has not been changed.',
          })
          .catch((err) => logger.error({ err: { name: err.name } }, 'notification email failed'));
      });
    }
  }

  // ── Sessions ──────────────────────────────────────────────────────────

  async function createSession({ userId, userRoles }, req, trx) {
    const lifetime = sessionLifetimeFor(userRoles, sessionLifetimes);
    const issuedAt = now();
    const absoluteExpiresAt = new Date(issuedAt.getTime() + lifetime.absoluteSeconds * 1000);
    const sessionId = newId();
    const secret = generateSecret();
    const csrfToken = generateSecret();

    await sessions.insert(
      {
        id: sessionId,
        user_id: userId,
        refresh_token_hash: sha256Hex(secret),
        csrf_token_hash: sha256Hex(csrfToken),
        idle_expires_at: nextIdleExpiry(issuedAt, lifetime.idleSeconds, absoluteExpiresAt),
        absolute_expires_at: absoluteExpiresAt,
        created_at: issuedAt,
        last_used_at: issuedAt,
        ip: clientIp(req),
        user_agent: req?.get?.('user-agent')?.slice(0, MAX_USER_AGENT) ?? null,
      },
      trx,
    );
    const access = await tokens.issueAccessToken({ userId, sessionId });
    return {
      sessionId,
      refreshToken: composeRefreshToken(sessionId, secret),
      csrfToken,
      accessToken: access,
      sessionExpiresAt: absoluteExpiresAt,
    };
  }

  // ── Login ─────────────────────────────────────────────────────────────

  async function login({ email, password }, req) {
    const user = await users.findCredentialsByEmail(email);
    if (!user) {
      await hasher.verifyDummy(password);
      await audit.recordBestEffort(
        {
          category: AUTH,
          action: 'auth.login',
          outcome: 'failure',
          actor: null,
          reason: 'unknown_account',
        },
        { req },
      );
      throw invalidCredentials();
    }

    const passwordValid = await hasher.verify(user.password_hash, password);
    const actor = { userId: user.id, roles: [] };

    if (user.locked_until && user.locked_until > now()) {
      await audit.recordBestEffort(
        {
          category: AUTH,
          action: 'auth.login',
          outcome: 'denied',
          actor,
          reason: 'account_locked',
        },
        { req },
      );
      throw invalidCredentials();
    }

    if (!passwordValid) {
      const state = await users.recordFailedLogin(user.id, LOCKOUT);
      const lockedNow = Boolean(state?.locked_until && state.locked_until > now());
      await audit.recordBestEffort(
        {
          category: AUTH,
          action: 'auth.login',
          outcome: 'failure',
          actor,
          reason: lockedNow ? 'invalid_password_account_locked' : 'invalid_password',
        },
        { req },
      );
      throw invalidCredentials();
    }

    // Only revealed to someone who knows the correct password.
    if (user.status !== 'active') {
      await audit.recordBestEffort(
        {
          category: AUTH,
          action: 'auth.login',
          outcome: 'denied',
          actor,
          reason: 'account_disabled',
        },
        { req },
      );
      throw new ForbiddenError(
        'This account is unavailable. Please contact support.',
        'account_unavailable',
      );
    }

    const userRoles = await roles.rolesOf(user.id);
    const rehash = hasher.needsRehash(user.password_hash) ? await hasher.hash(password) : undefined;

    const session = await knex.transaction(async (trx) => {
      await users.recordSuccessfulLogin(user.id, { passwordHash: rehash }, trx);
      const created = await createSession({ userId: user.id, userRoles }, req, trx);
      await audit.record(
        {
          category: AUTH,
          action: 'auth.login',
          outcome: 'success',
          actor: { userId: user.id, roles: userRoles, sessionId: created.sessionId },
          resourceType: 'session',
          resourceId: created.sessionId,
          metadata: rehash ? { passwordRehashed: true } : {},
        },
        { req, trx },
      );
      return created;
    });

    return {
      ...session,
      user: { id: user.id, email: user.email, fullName: user.full_name, roles: userRoles },
    };
  }

  // ── Refresh (rotation + reuse detection) ──────────────────────────────

  async function refresh({ refreshToken, csrfToken }, req) {
    const parsed = parseRefreshToken(refreshToken);
    if (!parsed) throw sessionInvalid();

    // Decisions that must persist (revocations) are committed before throwing.
    const outcome = await knex.transaction(async (trx) => {
      const session = await sessions.findForUpdate(parsed.sessionId, trx);
      if (!session) return { error: 'session_invalid', reason: 'unknown_session' };
      if (session.revoked_at)
        return { error: 'session_invalid', reason: 'session_revoked', session };

      const current = now();
      if (isSessionExpired(session, current)) {
        await sessions.revoke(session.id, REVOKE_REASONS.EXPIRED, trx);
        return { error: 'session_invalid', reason: 'session_expired', session };
      }
      if (!safeEqualHex(sha256Hex(csrfToken ?? ''), session.csrf_token_hash)) {
        return { error: 'csrf', reason: 'csrf_mismatch', session };
      }

      const presented = sha256Hex(parsed.secret);
      if (!safeEqualHex(presented, session.refresh_token_hash)) {
        const recentlyRotated =
          session.previous_refresh_token_hash &&
          safeEqualHex(presented, session.previous_refresh_token_hash) &&
          session.rotated_at &&
          current.getTime() - session.rotated_at.getTime() <= REFRESH_REUSE_GRACE_SECONDS * 1000;
        if (recentlyRotated)
          return { error: 'refresh_conflict', reason: 'concurrent_refresh', session };

        // A superseded refresh token was replayed: assume theft, kill the session.
        await sessions.revoke(session.id, REVOKE_REASONS.REFRESH_TOKEN_REUSE, trx);
        await audit.record(
          {
            category: AUTH,
            action: 'auth.refresh',
            outcome: 'denied',
            actor: { userId: session.user_id, sessionId: session.id },
            reason: 'refresh_token_reuse',
            resourceType: 'session',
            resourceId: session.id,
            metadata: { sessionRevoked: true },
          },
          { req, trx },
        );
        return { error: 'session_invalid', reason: 'refresh_token_reuse', audited: true, session };
      }

      const user = await users.findCredentialsById(session.user_id, trx);
      if (!user || user.status !== 'active') {
        await sessions.revoke(session.id, REVOKE_REASONS.ACCOUNT_DISABLED, trx);
        return { error: 'session_invalid', reason: 'account_inactive', session };
      }

      const userRoles = await roles.rolesOf(user.id, trx);
      const lifetime = sessionLifetimeFor(userRoles, sessionLifetimes);
      const secret = generateSecret();
      await sessions.rotate(
        session.id,
        {
          refreshTokenHash: sha256Hex(secret),
          previousRefreshTokenHash: session.refresh_token_hash,
          idleExpiresAt: nextIdleExpiry(current, lifetime.idleSeconds, session.absolute_expires_at),
        },
        trx,
      );
      return {
        session,
        user: { id: user.id, email: user.email, fullName: user.full_name, roles: userRoles },
        refreshToken: composeRefreshToken(session.id, secret),
      };
    });

    if (outcome.error) {
      if (!outcome.audited) {
        await audit.recordBestEffort(
          {
            category: AUTH,
            action: 'auth.refresh',
            outcome: 'denied',
            actor: outcome.session
              ? { userId: outcome.session.user_id, sessionId: outcome.session.id }
              : null,
            reason: outcome.reason,
            resourceType: 'session',
            resourceId: outcome.session?.id ?? null,
          },
          { req },
        );
      }
      if (outcome.error === 'csrf') {
        throw new ForbiddenError('Missing or invalid CSRF token.', 'csrf_token_invalid');
      }
      if (outcome.error === 'refresh_conflict') {
        throw new UnauthorizedError(
          'Session refresh already in progress. Retry.',
          'refresh_conflict',
        );
      }
      throw sessionInvalid();
    }

    const access = await tokens.issueAccessToken({
      userId: outcome.user.id,
      sessionId: outcome.session.id,
    });
    return {
      sessionId: outcome.session.id,
      refreshToken: outcome.refreshToken,
      csrfToken,
      accessToken: access,
      sessionExpiresAt: outcome.session.absolute_expires_at,
      user: outcome.user,
    };
  }

  // ── Logout ────────────────────────────────────────────────────────────

  /** Idempotent. Revokes the session only when the presented refresh secret is genuine. */
  async function logout({ refreshToken }, req) {
    const parsed = parseRefreshToken(refreshToken);
    if (!parsed) return;
    const session = await sessions.findById(parsed.sessionId);
    if (!session || session.revoked_at) return;
    const presented = sha256Hex(parsed.secret);
    const genuine =
      safeEqualHex(presented, session.refresh_token_hash) ||
      (session.previous_refresh_token_hash &&
        safeEqualHex(presented, session.previous_refresh_token_hash));
    if (!genuine) return;

    await knex.transaction(async (trx) => {
      if (!(await sessions.revoke(session.id, REVOKE_REASONS.LOGOUT, trx))) return;
      await audit.record(
        {
          category: AUTH,
          action: 'auth.logout',
          outcome: 'success',
          actor: { userId: session.user_id, sessionId: session.id },
          resourceType: 'session',
          resourceId: session.id,
        },
        { req, trx },
      );
    });
  }

  // ── Per-request principal ─────────────────────────────────────────────

  /** @returns {Promise<import('../../core/authz/principal.js').Principal | null>} */
  async function resolvePrincipal({ userId, sessionId }, req) {
    const row = await sessions.findPrincipal(sessionId);
    let reason = null;
    if (!row || row.user_id !== userId) reason = 'unknown_session';
    else if (row.revoked_at) reason = 'session_revoked';
    else if (isSessionExpired(row, now())) reason = 'session_expired';
    else if (row.deleted_at || row.status !== 'active') reason = 'account_inactive';

    if (reason) {
      await audit.recordBestEffort(
        {
          category: AUTH,
          action: 'auth.access_token',
          outcome: 'denied',
          actor: row ? { userId: row.user_id, sessionId } : null,
          reason,
          resourceType: 'session',
          resourceId: sessionId,
        },
        { req },
      );
      return null;
    }
    return {
      userId: row.user_id,
      sessionId: row.session_id,
      email: row.email,
      fullName: row.full_name,
      roles: row.roles,
      permissions: new Set(row.permissions),
    };
  }

  return { register, login, refresh, logout, resolvePrincipal, createSession };
}
