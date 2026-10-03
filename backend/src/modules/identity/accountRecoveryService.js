import { isUuid, newId } from '../../core/db/ids.js';
import { generateSecret, safeEqualHex, sha256Hex } from '../../core/auth/secrets.js';
import { BadRequestError, ValidationError } from '../../core/http/errors.js';
import { checkPasswordPolicy } from './domain/passwordPolicy.js';
import { REVOKE_REASONS } from './domain/sessionPolicy.js';

const AUTH = 'authentication';
const ACCOUNT = 'account';
export const ACCOUNT_TOKEN_TTL_MINUTES = Object.freeze({
  password_reset: 30,
  email_verification: 24 * 60,
});

const invalidLink = (purpose) =>
  new BadRequestError(
    purpose === 'password_reset'
      ? 'This reset link is invalid or has expired. Request a new one.'
      : 'This verification link is invalid or has expired. Request a new one.',
    'invalid_token',
  );

/** `<tokenId>.<secret>`; only SHA-256(secret) is stored. */
function parseToken(token) {
  const [id, secret, ...rest] = String(token).split('.');
  if (rest.length || !isUuid(id) || !/^[A-Za-z0-9_-]{43}$/.test(secret ?? '')) return null;
  return { id, secret };
}

/**
 * Password reset and email verification (M11). Tokens are single-use, short-lived,
 * stored only as hashes, delivered once by email inside a link *fragment* (never sent to
 * servers, proxies or logs), and every outcome is audited without the token.
 *
 * Reset requests answer identically and immediately whether or not the account exists
 * (no enumeration); the work happens after the response. A completed reset revokes every
 * session and lifts any lockout.
 */
export function createAccountRecoveryService({
  knex,
  users,
  sessions,
  hasher,
  audit,
  mailer,
  logger,
  appUrl,
  now = () => new Date(),
}) {
  const send = (message) =>
    mailer
      .send(message)
      .catch((err) =>
        logger.error({ err: { name: err.name }, template: message.template }, 'email failed'),
      );

  async function issue(trx, userId, purpose) {
    // A new link replaces any earlier one for the same purpose.
    await trx('account_tokens')
      .where({ user_id: userId, purpose })
      .whereNull('used_at')
      .update({ used_at: now() });
    const id = newId();
    const secret = generateSecret();
    const createdAt = now();
    await trx('account_tokens').insert({
      id,
      user_id: userId,
      purpose,
      token_hash: sha256Hex(secret),
      created_at: createdAt,
      expires_at: new Date(createdAt.getTime() + ACCOUNT_TOKEN_TTL_MINUTES[purpose] * 60_000),
    });
    return `${id}.${secret}`;
  }

  /** Locks and consumes a valid token; null when unknown, used, expired or altered. */
  async function consume(trx, token, purpose) {
    const parsed = parseToken(token);
    if (!parsed) return null;
    const row = await trx('account_tokens').where({ id: parsed.id, purpose }).forUpdate().first();
    if (
      !row ||
      row.used_at ||
      row.expires_at <= now() ||
      !safeEqualHex(sha256Hex(parsed.secret), row.token_hash)
    ) {
      return null;
    }
    await trx('account_tokens').where({ id: row.id }).update({ used_at: now() });
    return row;
  }

  // ── Password reset ─────────────────────────────────────────────────

  async function processResetRequest(email, req) {
    const user = await users.findCredentialsByEmail(email);
    if (!user || user.status !== 'active') {
      await audit.recordBestEffort(
        {
          category: AUTH,
          action: 'auth.password_reset_request',
          outcome: 'failure',
          actor: null,
          reason: user ? 'account_not_active' : 'unknown_account',
        },
        { req },
      );
      return;
    }
    const token = await knex.transaction(async (trx) => {
      const issued = await issue(trx, user.id, 'password_reset');
      await audit.record(
        {
          category: AUTH,
          action: 'auth.password_reset_request',
          outcome: 'success',
          actor: null,
          resourceType: 'user',
          resourceId: user.id,
        },
        { req, trx },
      );
      return issued;
    });
    await send({
      template: 'password_reset',
      to: user.email,
      subject: 'Reset your HealthBridge password',
      text:
        `Hello ${user.full_name},\n\n` +
        'We received a request to reset your HealthBridge password. Use this link within ' +
        `${ACCOUNT_TOKEN_TTL_MINUTES.password_reset} minutes:\n\n` +
        `${appUrl}/reset-password#token=${token}\n\n` +
        'If you did not ask for this, you can ignore this email: your password has not changed.',
    });
  }

  /** Returns immediately; the outcome is never visible to the caller. */
  function requestPasswordReset({ email }, req) {
    setImmediate(() => {
      processResetRequest(email, req).catch((err) =>
        logger.error({ err: { name: err.name } }, 'password reset request failed'),
      );
    });
  }

  async function resetPassword({ token, newPassword }, req) {
    const fail = async (reason) => {
      await audit.recordBestEffort(
        {
          category: AUTH,
          action: 'auth.password_reset',
          outcome: 'failure',
          actor: null,
          reason,
        },
        { req },
      );
      return invalidLink('password_reset');
    };
    // Validate the token before hashing (cheap rejection), but hash outside the transaction.
    const parsed = parseToken(token);
    if (!parsed) throw await fail('malformed_token');
    const preview = await knex('account_tokens')
      .join('users', 'users.id', 'account_tokens.user_id')
      .where({ 'account_tokens.id': parsed.id, purpose: 'password_reset' })
      .first('users.email', 'users.full_name', 'users.status');
    if (!preview || preview.status !== 'active') throw await fail('invalid_token');
    const policyError = checkPasswordPolicy(newPassword, {
      email: preview.email,
      fullName: preview.full_name,
    });
    if (policyError)
      throw new ValidationError([{ path: 'body.newPassword', message: policyError }]);
    const passwordHash = await hasher.hash(newPassword);

    const result = await knex.transaction(async (trx) => {
      const row = await consume(trx, token, 'password_reset');
      if (!row) return null;
      await users.completePasswordReset(row.user_id, passwordHash, trx);
      const revoked = await sessions.revokeAllForUser(
        row.user_id,
        REVOKE_REASONS.PASSWORD_RESET,
        {},
        trx,
      );
      await audit.record(
        {
          category: AUTH,
          action: 'auth.password_reset',
          outcome: 'success',
          actor: { userId: row.user_id },
          resourceType: 'user',
          resourceId: row.user_id,
          metadata: { sessionsRevoked: revoked },
        },
        { req, trx },
      );
      return row;
    });
    if (!result) throw await fail('invalid_token');

    setImmediate(() =>
      send({
        template: 'password_changed',
        to: preview.email,
        subject: 'Your HealthBridge password was changed',
        text:
          `Hello ${preview.full_name},\n\n` +
          'Your HealthBridge password was just reset and you were signed out everywhere.\n' +
          'If this was not you, contact support immediately.',
      }),
    );
    return { status: 'password_reset' };
  }

  // ── Email verification ─────────────────────────────────────────────

  async function sendEmailVerification(userId, req) {
    const user = await users.findById(userId);
    if (!user || user.status !== 'active') return { status: 'skipped' };
    if (user.email_verified_at) return { status: 'already_verified' };
    const token = await knex.transaction(async (trx) => {
      const issued = await issue(trx, userId, 'email_verification');
      await audit.record(
        {
          category: ACCOUNT,
          action: 'account.email_verification_request',
          outcome: 'success',
          actor: req?.principal ?? { userId },
          resourceType: 'user',
          resourceId: userId,
        },
        { req, trx },
      );
      return issued;
    });
    setImmediate(() =>
      send({
        template: 'email_verification',
        to: user.email,
        subject: 'Confirm your email for HealthBridge',
        text:
          `Hello ${user.full_name},\n\n` +
          'Please confirm this email address for your HealthBridge account:\n\n' +
          `${appUrl}/verify-email#token=${token}\n\n` +
          'The link works for 24 hours. If you did not create an account, ignore this email.',
      }),
    );
    return { status: 'sent' };
  }

  async function verifyEmail({ token }, req) {
    const row = await knex.transaction(async (trx) => {
      const consumed = await consume(trx, token, 'email_verification');
      if (!consumed) return null;
      await users.markEmailVerified(consumed.user_id, trx);
      await audit.record(
        {
          category: ACCOUNT,
          action: 'account.email_verified',
          outcome: 'success',
          actor: { userId: consumed.user_id },
          resourceType: 'user',
          resourceId: consumed.user_id,
        },
        { req, trx },
      );
      return consumed;
    });
    if (!row) {
      await audit.recordBestEffort(
        {
          category: ACCOUNT,
          action: 'account.email_verified',
          outcome: 'failure',
          actor: null,
          reason: 'invalid_token',
        },
        { req },
      );
      throw invalidLink('email_verification');
    }
    return { status: 'verified' };
  }

  return { requestPasswordReset, resetPassword, sendEmailVerification, verifyEmail };
}
