/** @param {{ knex: import('knex').Knex }} deps */
export function createRoleRepository({ knex }) {
  const db = (trx) => trx ?? knex;
  const NIL_UUID = '00000000-0000-0000-0000-000000000000';

  return {
    /** Role codes in force (global, plus clinic roles backed by an active membership). */
    async rolesOf(userId, trx) {
      const rows = await db(trx)('effective_role_grants')
        .where('user_id', userId)
        .distinct('role')
        .orderBy('role');
      return rows.map((r) => r.role);
    },

    /** Role assignments as stored (including clinic scope), for administration views. */
    assignmentsOf(userId, trx) {
      return db(trx)('user_roles')
        .join('roles', 'roles.id', 'user_roles.role_id')
        .where('user_roles.user_id', userId)
        .select('roles.code as role', 'user_roles.clinic_id as clinicId')
        .orderBy('roles.code');
    },

    async scopeOf(roleCode, trx) {
      const role = await db(trx)('roles').where({ code: roleCode }).first('scope');
      return role?.scope ?? null;
    },

    /**
     * Idempotent: granting an existing assignment is a no-op. Returns true if added.
     * Clinic-scoped roles require `clinicId` (enforced by a database trigger too).
     */
    async grant(userId, roleCode, grantedBy, trx, { clinicId = null } = {}) {
      const role = await db(trx)('roles').where({ code: roleCode }).first('id');
      if (!role) return false;
      const inserted = await db(trx)('user_roles')
        .insert({ user_id: userId, role_id: role.id, granted_by: grantedBy, clinic_id: clinicId })
        .onConflict(knex.raw(`(user_id, role_id, COALESCE(clinic_id, '${NIL_UUID}'::uuid))`))
        .ignore()
        .returning('id');
      return inserted.length > 0;
    },

    /**
     * Returns true if an assignment was removed. Without `clinicId` this removes the
     * global assignment only; clinic-scoped assignments are removed per clinic.
     */
    async revoke(userId, roleCode, trx, { clinicId = null } = {}) {
      const query = db(trx)('user_roles')
        .where('user_id', userId)
        .whereIn('role_id', db(trx)('roles').select('id').where({ code: roleCode }));
      if (clinicId) query.where('clinic_id', clinicId);
      else query.whereNull('clinic_id');
      return (await query.del()) > 0;
    },

    async countUsersWithRole(roleCode, trx) {
      const [{ count }] = await db(trx)('user_roles')
        .join('roles', 'roles.id', 'user_roles.role_id')
        .join('users', 'users.id', 'user_roles.user_id')
        .where('roles.code', roleCode)
        .whereNull('user_roles.clinic_id')
        .where('users.status', 'active')
        .whereNull('users.deleted_at')
        .countDistinct({ count: 'user_roles.user_id' });
      return Number(count);
    },

    /**
     * Effective role and permission grants of a user (same shape as principal loading).
     * Used by operational scripts that act as a specific user without a session.
     */
    async grantsFor(userId) {
      const roleGrants = await knex('effective_role_grants')
        .where('user_id', userId)
        .select('role', 'clinic_id as clinicId');
      const permissionGrants = await knex('effective_role_grants as g')
        .join('roles as r', 'r.code', 'g.role')
        .join('role_permissions as rp', 'rp.role_id', 'r.id')
        .join('permissions as p', 'p.id', 'rp.permission_id')
        .where('g.user_id', userId)
        .distinct('p.code as permission', 'g.clinic_id as clinicId');
      return { roleGrants, permissionGrants };
    },

    /** Permission codes present in the database (startup drift check). */
    async permissionCatalog() {
      const permissions = (await knex('permissions').select('code')).map((r) => r.code);
      const mapping = await knex('role_permissions')
        .join('roles', 'roles.id', 'role_permissions.role_id')
        .join('permissions', 'permissions.id', 'role_permissions.permission_id')
        .select('roles.code as role', 'permissions.code as permission');
      const scopes = await knex('roles').select('code as role', 'scope');
      return { permissions, mapping, scopes };
    },
  };
}
