import { CURRENT_TERMS_VERSION, ROLES, WORKFLOW_GRANTED_ROLES } from '@healthbridge/shared';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../core/http/errors.js';
import { isUuid, newId } from '../../core/db/ids.js';
import { checkPasswordPolicy } from '../identity/domain/passwordPolicy.js';
import { REVOKE_REASONS } from '../identity/domain/sessionPolicy.js';
import { toUserView } from '../identity/repositories/userRepository.js';

const ADMIN = 'administration';

/**
 * Platform administration of user accounts. Route-level permissions (gate 1) are
 * enforced by AccessPolicy middleware; this service enforces business invariants and
 * audits every action, including reads of other users' account data.
 */
export function createAdminUserService({ knex, users, roles, sessions, audit, hasher }) {
  async function requireUser(userId) {
    const user = isUuid(userId) ? await users.findById(userId) : null;
    if (!user) throw new NotFoundError();
    return user;
  }

  async function listUsers(filter, req) {
    const page = await users.list(filter);
    await audit.record(
      {
        category: ADMIN,
        action: 'admin.users_list',
        outcome: 'success',
        resourceType: 'user',
        // Search text may contain personal data; record only that a search was used.
        metadata: {
          role: filter.role,
          status: filter.status,
          hasQuery: Boolean(filter.q),
          count: page.items.length,
        },
      },
      { req },
    );
    return page;
  }

  async function getUser(userId, req) {
    const user = await requireUser(userId);
    await audit.record(
      {
        category: ADMIN,
        action: 'admin.user_read',
        outcome: 'success',
        resourceType: 'user',
        resourceId: userId,
      },
      { req },
    );
    return toUserView(user);
  }

  /** Disabling an account revokes all of its sessions immediately. */
  async function setStatus(principal, userId, { status, reasonCode }, req) {
    if (userId === principal.userId) {
      throw new BadRequestError(
        'You cannot change the status of your own account.',
        'self_modification',
      );
    }
    await requireUser(userId);
    await knex.transaction(async (trx) => {
      await users.setStatus(userId, status, trx);
      const revoked =
        status === 'disabled'
          ? await sessions.revokeAllForUser(userId, REVOKE_REASONS.ACCOUNT_DISABLED, {}, trx)
          : 0;
      await audit.record(
        {
          category: ADMIN,
          action: 'admin.user_status_update',
          outcome: 'success',
          resourceType: 'user',
          resourceId: userId,
          reason: reasonCode,
          metadata: { status, sessionsRevoked: revoked },
        },
        { req, trx },
      );
    });
    return toUserView(await users.findById(userId));
  }

  /** DOCTOR comes only from verification; clinic roles only from clinic workflows. */
  function assertDirectlyGrantable(role) {
    if (WORKFLOW_GRANTED_ROLES.includes(role)) {
      throw new BadRequestError(
        role === ROLES.DOCTOR
          ? 'The doctor role is granted only through credential verification.'
          : 'Clinic roles are granted through clinic administration.',
        'role_requires_workflow',
      );
    }
  }

  async function grantRole(principal, userId, role, req) {
    assertDirectlyGrantable(role);
    await requireUser(userId);
    await knex.transaction(async (trx) => {
      const added = await roles.grant(userId, role, principal.userId, trx);
      await audit.record(
        {
          category: ADMIN,
          action: 'admin.user_role_grant',
          outcome: 'success',
          resourceType: 'user',
          resourceId: userId,
          metadata: { role, alreadyAssigned: !added },
        },
        { req, trx },
      );
    });
    return toUserView(await users.findById(userId));
  }

  async function revokeRole(principal, userId, role, req) {
    assertDirectlyGrantable(role);
    await requireUser(userId);
    if (role === ROLES.PLATFORM_ADMIN && userId === principal.userId) {
      throw new BadRequestError(
        'You cannot remove your own administrator role.',
        'self_modification',
      );
    }
    await knex.transaction(async (trx) => {
      if (
        role === ROLES.PLATFORM_ADMIN &&
        (await roles.countUsersWithRole(ROLES.PLATFORM_ADMIN, trx)) <= 1
      ) {
        throw new ConflictError('The last platform administrator cannot be removed.', 'last_admin');
      }
      const removed = await roles.revoke(userId, role, trx);
      await audit.record(
        {
          category: ADMIN,
          action: 'admin.user_role_revoke',
          outcome: 'success',
          resourceType: 'user',
          resourceId: userId,
          metadata: { role, wasAssigned: removed },
        },
        { req, trx },
      );
    });
    return toUserView(await users.findById(userId));
  }

  async function revokeSessions(userId, req) {
    await requireUser(userId);
    return knex.transaction(async (trx) => {
      const revoked = await sessions.revokeAllForUser(
        userId,
        REVOKE_REASONS.ADMIN_REVOKED,
        {},
        trx,
      );
      await audit.record(
        {
          category: ADMIN,
          action: 'admin.user_sessions_revoke',
          outcome: 'success',
          resourceType: 'user',
          resourceId: userId,
          metadata: { revoked },
        },
        { req, trx },
      );
      return { revoked };
    });
  }

  /**
   * Provisions an account with exactly the given roles (operational scripts: first admin,
   * synthetic demo users). Idempotent: an existing account only gains missing roles; its
   * password is never changed here.
   * @returns {Promise<{ id: string, created: boolean, roles: string[] }>}
   */
  async function provisionUser({ email, fullName, password, roles: wanted, isDemo = false }) {
    wanted.forEach(assertDirectlyGrantable);
    const policyError = checkPasswordPolicy(password, { email, fullName });
    if (policyError) throw new ValidationError([{ path: 'password', message: policyError }]);
    const passwordHash = await hasher.hash(password);

    return knex.transaction(async (trx) => {
      const existing = await users.emailExists(email, trx);
      const id = existing?.id ?? newId();
      if (!existing) {
        await users.insert(
          {
            id,
            email,
            full_name: fullName,
            password_hash: passwordHash,
            is_demo: isDemo,
            terms_accepted_at: new Date(),
            terms_version: CURRENT_TERMS_VERSION,
          },
          trx,
        );
      }
      for (const role of wanted) await roles.grant(id, role, null, trx);
      await audit.record(
        {
          category: ADMIN,
          action: 'admin.user_provision',
          outcome: 'success',
          actor: 'system',
          resourceType: 'user',
          resourceId: id,
          metadata: { roles: wanted, created: !existing, isDemo },
        },
        { trx },
      );
      return { id, created: !existing, roles: await roles.rolesOf(id, trx) };
    });
  }

  return { listUsers, getUser, setStatus, grantRole, revokeRole, revokeSessions, provisionUser };
}
