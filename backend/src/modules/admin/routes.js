import { Router } from 'express';
import { z } from 'zod';
import { ALL_ROLES, PERMISSIONS } from '@healthbridge/shared';
import { validate } from '../../core/http/validate.js';
import { paginationQuery } from '../../core/http/pagination.js';

const userIdParams = z.object({ userId: z.string().max(64) });
const roleParams = userIdParams.extend({ role: z.enum(ALL_ROLES) });

const listUsersQuery = z
  .object({
    ...paginationQuery,
    role: z.enum(ALL_ROLES).optional(),
    status: z.enum(['active', 'disabled']).optional(),
    q: z.string().trim().min(2).max(100).optional(),
  })
  .strict();

const statusBody = z
  .object({
    status: z.enum(['active', 'disabled']),
    // Reason codes, not free text: audit rows must not accumulate personal data.
    reasonCode: z.enum([
      'security_concern',
      'user_request',
      'policy_violation',
      'reinstated',
      'other',
    ]),
  })
  .strict();

const auditQuery = z
  .object({
    ...paginationQuery,
    actorUserId: z.uuid().optional(),
    action: z.string().max(80).optional(),
    outcome: z.enum(['success', 'failure', 'denied']).optional(),
    category: z
      .enum([
        'authentication',
        'authorization',
        'account',
        'administration',
        'data_access',
        'system',
      ])
      .optional(),
    requestId: z.string().max(64).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .strict();

/**
 * /admin/* routes. Every route requires authentication and an explicit permission.
 * @param {ReturnType<typeof import('../../container.js').createContainer>} container
 */
export function adminRoutes(container) {
  const { authenticate, accessPolicy, adminUserService, auditRepository, audit } = container;
  const router = Router();
  const can = (permission) => [authenticate(), accessPolicy.requirePermission(permission)];

  router.get(
    '/admin/users',
    can(PERMISSIONS.USERS_READ),
    validate({ query: listUsersQuery }),
    async (req, res) => {
      res.set('Cache-Control', 'no-store');
      const page = await adminUserService.listUsers(req.valid.query, req);
      res.json({ data: page.items, meta: { nextCursor: page.nextCursor } });
    },
  );

  router.get(
    '/admin/users/:userId',
    can(PERMISSIONS.USERS_READ),
    validate({ params: userIdParams }),
    async (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.json({ data: await adminUserService.getUser(req.valid.params.userId, req) });
    },
  );

  router.patch(
    '/admin/users/:userId/status',
    can(PERMISSIONS.USERS_UPDATE),
    validate({ params: userIdParams, body: statusBody }),
    async (req, res) => {
      res.json({
        data: await adminUserService.setStatus(
          req.principal,
          req.valid.params.userId,
          req.valid.body,
          req,
        ),
      });
    },
  );

  router.put(
    '/admin/users/:userId/roles/:role',
    can(PERMISSIONS.ADMIN_USERS),
    validate({ params: roleParams }),
    async (req, res) => {
      const { userId, role } = req.valid.params;
      res.json({ data: await adminUserService.grantRole(req.principal, userId, role, req) });
    },
  );

  router.delete(
    '/admin/users/:userId/roles/:role',
    can(PERMISSIONS.ADMIN_USERS),
    validate({ params: roleParams }),
    async (req, res) => {
      const { userId, role } = req.valid.params;
      res.json({ data: await adminUserService.revokeRole(req.principal, userId, role, req) });
    },
  );

  router.post(
    '/admin/users/:userId/sessions/revoke',
    can(PERMISSIONS.ADMIN_SESSIONS),
    validate({ params: userIdParams }),
    async (req, res) => {
      res.json({ data: await adminUserService.revokeSessions(req.valid.params.userId, req) });
    },
  );

  router.get(
    '/admin/audit-logs',
    can(PERMISSIONS.AUDIT_READ),
    validate({ query: auditQuery }),
    async (req, res) => {
      const page = await auditRepository.list(req.valid.query);
      // Reading the audit trail is itself audited.
      await audit.record(
        {
          category: 'administration',
          action: 'audit.read',
          outcome: 'success',
          resourceType: 'audit_log',
          metadata: {
            filters: Object.keys(req.valid.query).filter((k) => !['cursor', 'limit'].includes(k)),
            count: page.items.length,
          },
        },
        { req },
      );
      res.set('Cache-Control', 'no-store');
      res.json({ data: page.items, meta: { nextCursor: page.nextCursor } });
    },
  );

  return router;
}
