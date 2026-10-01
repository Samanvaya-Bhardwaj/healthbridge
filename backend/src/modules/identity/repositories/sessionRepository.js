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
     * account state, roles and the permission union.
     */
    async findPrincipal(sessionId) {
      const result = await knex.raw(
        `SELECT s.id AS session_id, s.user_id, s.revoked_at, s.idle_expires_at, s.absolute_expires_at,
                u.email, u.full_name, u.status, u.deleted_at,
                COALESCE(array_agg(DISTINCT r.code) FILTER (WHERE r.code IS NOT NULL), '{}') AS roles,
                COALESCE(array_agg(DISTINCT p.code) FILTER (WHERE p.code IS NOT NULL), '{}') AS permissions
           FROM sessions s
           JOIN users u ON u.id = s.user_id
           LEFT JOIN user_roles ur ON ur.user_id = u.id
           LEFT JOIN roles r ON r.id = ur.role_id
           LEFT JOIN role_permissions rp ON rp.role_id = r.id
           LEFT JOIN permissions p ON p.id = rp.permission_id
          WHERE s.id = ?
          GROUP BY s.id, u.id`,
        [sessionId],
      );
      return result.rows[0] ?? null;
    },
  };
}
