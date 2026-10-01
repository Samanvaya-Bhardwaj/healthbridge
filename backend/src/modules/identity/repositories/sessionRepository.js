/** @param {{ knex: import('knex').Knex }} deps */
export function createSessionRepository({ knex }) {
  const db = (trx) => trx ?? knex;

  return {
    async insert(session, trx) {
      await db(trx)('sessions').insert(session);
    },

    /** Row-locks the session for the duration of the transaction (serialises refreshes). */
    findForUpdate(id, trx) {
      return trx('sessions').where({ id }).forUpdate().first();
    },

    findById(id, trx) {
      return db(trx)('sessions').where({ id }).first();
    },

    async rotate(id, { refreshTokenHash, previousRefreshTokenHash, idleExpiresAt }, trx) {
      await db(trx)('sessions')
        .where({ id })
        .update({
          refresh_token_hash: refreshTokenHash,
          previous_refresh_token_hash: previousRefreshTokenHash,
          rotated_at: knex.fn.now(),
          rotation_count: knex.raw('rotation_count + 1'),
          last_used_at: knex.fn.now(),
          idle_expires_at: idleExpiresAt,
        });
    },

    /** Returns true if an active session was revoked. */
    async revoke(id, reason, trx) {
      const count = await db(trx)('sessions')
        .where({ id })
        .whereNull('revoked_at')
        .update({ revoked_at: knex.fn.now(), revoked_reason: reason });
      return count > 0;
    },

    /** Revokes all active sessions of a user, optionally keeping one. Returns the count. */
    revokeAllForUser(userId, reason, { exceptSessionId } = {}, trx) {
      const query = db(trx)('sessions').where({ user_id: userId }).whereNull('revoked_at');
      if (exceptSessionId) query.whereNot({ id: exceptSessionId });
      return query.update({ revoked_at: knex.fn.now(), revoked_reason: reason });
    },

    listActiveForUser(userId) {
      return knex('sessions')
        .select(
          'id',
          'created_at',
          'last_used_at',
          'idle_expires_at',
          'absolute_expires_at',
          'ip',
          'user_agent',
        )
        .where({ user_id: userId })
        .whereNull('revoked_at')
        .where('idle_expires_at', '>', knex.fn.now())
        .where('absolute_expires_at', '>', knex.fn.now())
        .orderBy('last_used_at', 'desc');
    },

    /**
     * Loads everything needed to authorise a request in one round trip: session state,
     * account state, and the role/permission grants in force. Grants come from the
     * `effective_role_grants` view, so clinic-scoped roles count only while the clinic
     * membership and clinic are active. `clinic_id` is null for global grants.
     */
    async findPrincipal(sessionId) {
      const result = await knex.raw(
        `SELECT s.id AS session_id, s.user_id, s.revoked_at, s.idle_expires_at, s.absolute_expires_at,
                u.email, u.full_name, u.status, u.deleted_at,
                COALESCE((SELECT jsonb_agg(DISTINCT jsonb_build_object('role', g.role, 'clinicId', g.clinic_id))
                            FROM effective_role_grants g WHERE g.user_id = u.id), '[]') AS role_grants,
                COALESCE((SELECT jsonb_agg(DISTINCT jsonb_build_object('permission', p.code, 'clinicId', g.clinic_id))
                            FROM effective_role_grants g
                            JOIN roles r ON r.code = g.role
                            JOIN role_permissions rp ON rp.role_id = r.id
                            JOIN permissions p ON p.id = rp.permission_id
                           WHERE g.user_id = u.id), '[]') AS permission_grants
           FROM sessions s
           JOIN users u ON u.id = s.user_id
          WHERE s.id = ?`,
        [sessionId],
      );
      return result.rows[0] ?? null;
    },
  };
}
