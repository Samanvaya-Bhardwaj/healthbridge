/** @param {{ knex: import('knex').Knex }} deps */
export function createRoleRepository({ knex }) {
  const db = (trx) => trx ?? knex;

  return {
    async rolesOf(userId, trx) {
      const rows = await db(trx)('user_roles')
        .join('roles', 'roles.id', 'user_roles.role_id')
        .where('user_roles.user_id', userId)
        .distinct('roles.code')
        .orderBy('roles.code');
      return rows.map((r) => r.code);
    },

    /** Idempotent: granting an existing (unscoped) role is a no-op. Returns true if added. */
    async grant(userId, roleCode, grantedBy, trx) {
      const role = await db(trx)('roles').where({ code: roleCode }).first('id');
      if (!role) return false;
      const inserted = await db(trx)('user_roles')
        .insert({ user_id: userId, role_id: role.id, granted_by: grantedBy })
        .onConflict(
          knex.raw(
            "(user_id, role_id, COALESCE(clinic_id, '00000000-0000-0000-0000-000000000000'::uuid))",
          ),
        )
        .ignore()
        .returning('id');
      return inserted.length > 0;
    },

    /** Returns true if a role assignment was removed. */
    async revoke(userId, roleCode, trx) {
      const count = await db(trx)('user_roles')
        .where('user_id', userId)
        .whereIn('role_id', db(trx)('roles').select('id').where({ code: roleCode }))
        .del();
      return count > 0;
    },

    async countUsersWithRole(roleCode, trx) {
      const [{ count }] = await db(trx)('user_roles')
        .join('roles', 'roles.id', 'user_roles.role_id')
        .join('users', 'users.id', 'user_roles.user_id')
        .where('roles.code', roleCode)
        .where('users.status', 'active')
        .whereNull('users.deleted_at')
        .countDistinct({ count: 'user_roles.user_id' });
      return Number(count);
    },

    /** Permission codes present in the database (startup drift check). */
    async permissionCatalog() {
      const permissions = (await knex('permissions').select('code')).map((r) => r.code);
      const mapping = await knex('role_permissions')
        .join('roles', 'roles.id', 'role_permissions.role_id')
        .join('permissions', 'permissions.id', 'role_permissions.permission_id')
        .select('roles.code as role', 'permissions.code as permission');
      return { permissions, mapping };
    },
  };
}
