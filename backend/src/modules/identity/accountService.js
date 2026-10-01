import { PERMISSIONS } from '@healthbridge/shared';
import { isUuid } from '../../core/db/ids.js';
import { NotFoundError, ValidationError } from '../../core/http/errors.js';
import { checkPasswordPolicy } from './domain/passwordPolicy.js';
import { REVOKE_REASONS } from './domain/sessionPolicy.js';
import { toUserView } from './repositories/userRepository.js';

const ACCOUNT = 'account';
const AUTH_CATEGORY = 'authentication';

/** Self-service account and session management for the authenticated user. */
export function createAccountService({ knex, users, sessions, hasher, audit, accessPolicy }) {
  async function getAccount(principal) {
    const row = await users.findById(principal.userId);
    if (!row) throw new NotFoundError();
    return toUserView(row);
  }

  async function updateProfile(principal, { fullName }, req) {
    await knex.transaction(async (trx) => {
      await users.updateProfile(principal.userId, { fullName }, trx);
      await audit.record(
        {
          category: ACCOUNT,
          action: 'account.profile_update',
          outcome: 'success',
          resourceType: 'user',
          resourceId: principal.userId,
          metadata: { fields: ['fullName'] },
        },
        { req, trx },
      );
    });
    return getAccount(principal);
  }

  /** Changing the password signs out every other session. */
  async function changePassword(principal, { currentPassword, newPassword }, req) {
    const user = await users.findCredentialsById(principal.userId);
    if (!user) throw new NotFoundError();

    if (!(await hasher.verify(user.password_hash, currentPassword))) {
      await audit.recordBestEffort(
        {
          category: ACCOUNT,
          action: 'account.password_change',
          outcome: 'failure',
          reason: 'current_password_incorrect',
          resourceType: 'user',
          resourceId: principal.userId,
        },
        { req },
      );
      throw new ValidationError([
        { path: 'body.currentPassword', message: 'Current password is incorrect.' },
      ]);
    }
    const policyError = checkPasswordPolicy(newPassword, {
      email: user.email,
      fullName: user.full_name,
    });
    if (policyError)
      throw new ValidationError([{ path: 'body.newPassword', message: policyError }]);
    if (await hasher.verify(user.password_hash, newPassword)) {
      throw new ValidationError([
        { path: 'body.newPassword', message: 'Choose a password different from your current one.' },
      ]);
    }

    const passwordHash = await hasher.hash(newPassword);
    return knex.transaction(async (trx) => {
      await users.updatePassword(principal.userId, passwordHash, trx);
      const revoked = await sessions.revokeAllForUser(
        principal.userId,
        REVOKE_REASONS.PASSWORD_CHANGED,
        { exceptSessionId: principal.sessionId },
        trx,
      );
      await audit.record(
        {
          category: ACCOUNT,
          action: 'account.password_change',
          outcome: 'success',
          resourceType: 'user',
          resourceId: principal.userId,
          metadata: { otherSessionsRevoked: revoked },
        },
        { req, trx },
      );
      return { otherSessionsRevoked: revoked };
    });
  }

  async function listSessions(principal) {
    const rows = await sessions.listActiveForUser(principal.userId);
    return rows.map((row) => ({
      id: row.id,
      current: row.id === principal.sessionId,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      expiresAt:
        row.idle_expires_at < row.absolute_expires_at
          ? row.idle_expires_at
          : row.absolute_expires_at,
      ip: row.ip,
      userAgent: row.user_agent,
    }));
  }

  /** Gate 2 via AccessPolicy: a user may only revoke sessions they own (else 404). */
  async function revokeSession(principal, sessionId, req) {
    const session = isUuid(sessionId) ? await sessions.findById(sessionId) : null;
    await accessPolicy.enforce({
      principal,
      permission: PERMISSIONS.SESSIONS_REVOKE,
      resource: { type: 'session', id: sessionId, ownerUserId: session?.user_id },
      req,
    });
    await knex.transaction(async (trx) => {
      const revoked = await sessions.revoke(sessionId, REVOKE_REASONS.USER_REVOKED, trx);
      await audit.record(
        {
          category: AUTH_CATEGORY,
          action: 'auth.session_revoke',
          outcome: 'success',
          resourceType: 'session',
          resourceId: sessionId,
          metadata: { alreadyRevoked: !revoked, current: sessionId === principal.sessionId },
        },
        { req, trx },
      );
    });
  }

  async function revokeOtherSessions(principal, req) {
    return knex.transaction(async (trx) => {
      const revoked = await sessions.revokeAllForUser(
        principal.userId,
        REVOKE_REASONS.USER_REVOKED,
        { exceptSessionId: principal.sessionId },
        trx,
      );
      await audit.record(
        {
          category: AUTH_CATEGORY,
          action: 'auth.sessions_revoke_others',
          outcome: 'success',
          resourceType: 'user',
          resourceId: principal.userId,
          metadata: { revoked },
        },
        { req, trx },
      );
      return { revoked };
    });
  }

  return {
    getAccount,
    updateProfile,
    changePassword,
    listSessions,
    revokeSession,
    revokeOtherSessions,
  };
}
