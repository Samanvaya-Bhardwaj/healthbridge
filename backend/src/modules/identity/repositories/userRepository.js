import { decodeCursor, encodeCursor } from '../../../core/http/pagination.js';

/** Columns safe to return from the users table. password_hash is never selected here. */
const PUBLIC_COLUMNS = [
  'users.id',
  'users.email',
  'users.full_name',
  'users.status',
  'users.is_demo',
  'users.last_login_at',
  'users.locked_until',
  'users.email_verified_at',
  'users.created_at',
  'users.updated_at',
];

const rolesSubquery = (knex) =>
  knex.raw(
    `COALESCE((SELECT array_agg(r.code ORDER BY r.code) FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = users.id), '{}') AS roles`,
  );

export function toUserView(row) {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    status: row.status,
    roles: row.roles ?? [],
    isDemo: row.is_demo,
    lastLoginAt: row.last_login_at,
    lockedUntil: row.locked_until,
    emailVerifiedAt: row.email_verified_at,
    createdAt: row.created_at,
  };
}

/** @param {{ knex: import('knex').Knex }} deps */
export function createUserRepository({ knex }) {
  const db = (trx) => trx ?? knex;

  return {
    /** Includes password_hash: for credential verification only. */
    findCredentialsByEmail(email, trx) {
      return db(trx)('users')
        .select(
          'id',
          'email',
          'full_name',
          'password_hash',
          'status',
          'failed_login_attempts',
          'locked_until',
        )
        .where({ email })
        .whereNull('deleted_at')
        .first();
    },

    findCredentialsById(id, trx) {
      return db(trx)('users')
        .select('id', 'email', 'full_name', 'password_hash', 'status')
        .where({ id })
        .whereNull('deleted_at')
        .first();
    },

    findById(id, trx) {
      return db(trx)('users')
        .select(PUBLIC_COLUMNS)
        .select(rolesSubquery(knex))
        .where('users.id', id)
        .whereNull('users.deleted_at')
        .first();
    },

    emailExists(email, trx) {
      return db(trx)('users').where({ email }).whereNull('deleted_at').first('id');
    },

    async insert(user, trx) {
      await db(trx)('users').insert(user);
    },

    /**
     * Atomically records a failed attempt and applies the temporary lock when the
     * threshold is reached (counter resets when the lock is set).
     */
    async recordFailedLogin(id, { maxFailedAttempts, lockMinutes }, trx) {
      const [row] = await db(trx)('users')
        .where({ id })
        .update({
          failed_login_attempts: knex.raw(
            'CASE WHEN failed_login_attempts + 1 >= ? THEN 0 ELSE failed_login_attempts + 1 END',
            [maxFailedAttempts],
          ),
          locked_until: knex.raw(
            `CASE WHEN failed_login_attempts + 1 >= ? THEN now() + make_interval(mins => ?) ELSE locked_until END`,
            [maxFailedAttempts, lockMinutes],
          ),
        })
        .returning(['failed_login_attempts', 'locked_until']);
      return row;
    },

    async recordSuccessfulLogin(id, { passwordHash } = {}, trx) {
      await db(trx)('users')
        .where({ id })
        .update({
          failed_login_attempts: 0,
          locked_until: null,
          last_login_at: knex.fn.now(),
          ...(passwordHash ? { password_hash: passwordHash } : {}),
        });
    },

    async updatePassword(id, passwordHash, trx) {
      await db(trx)('users')
        .where({ id })
        .update({ password_hash: passwordHash, password_changed_at: knex.fn.now() });
    },

    async updateProfile(id, { fullName }, trx) {
      await db(trx)('users').where({ id }).update({ full_name: fullName });
    },

    async setStatus(id, status, trx) {
      const count = await db(trx)('users').where({ id }).whereNull('deleted_at').update({ status });
      return count > 0;
    },

    /**
     * Keyset-paginated listing for administration.
     * @param {{ role?: string, status?: string, q?: string, cursor?: string, limit: number }} filter
     */
    async list({ role, status, q, cursor, limit }) {
      const query = knex('users')
        .select(PUBLIC_COLUMNS)
        .select(rolesSubquery(knex))
        .whereNull('users.deleted_at');
      if (status) query.where('users.status', status);
      if (role) {
        query.whereExists(
          knex('user_roles')
            .join('roles', 'roles.id', 'user_roles.role_id')
            .whereRaw('user_roles.user_id = users.id')
            .where('roles.code', role),
        );
      }
      if (q) {
        const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        query.where((w) =>
          w.whereILike('users.email', pattern).orWhereILike('users.full_name', pattern),
        );
      }
      const after = decodeCursor(cursor);
      if (after)
        query.whereRaw('(users.created_at, users.id) < (?::timestamptz, ?::uuid)', [
          after.t,
          after.id,
        ]);

      const rows = await query
        .orderBy([
          { column: 'users.created_at', order: 'desc' },
          { column: 'users.id', order: 'desc' },
        ])
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map(toUserView),
        nextCursor:
          rows.length > limit && last
            ? encodeCursor({ t: last.created_at.toISOString(), id: last.id })
            : null,
      };
    },
  };
}
