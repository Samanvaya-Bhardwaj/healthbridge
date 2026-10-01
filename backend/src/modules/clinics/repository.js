import { decodeCursor, encodeCursor } from '../../core/http/pagination.js';

export function toClinicView(row) {
  return {
    id: row.id,
    name: row.name,
    registrationNumber: row.registration_number,
    phone: row.phone_e164,
    email: row.email,
    addressLine: row.address_line,
    city: row.city,
    state: row.state,
    postalCode: row.postal_code,
    countryCode: row.country_code?.trim() ?? null,
    status: row.status,
    isDemo: row.is_demo,
    createdAt: row.created_at,
  };
}

export function toMembershipView(row) {
  return {
    id: row.id,
    clinicId: row.clinic_id,
    userId: row.user_id,
    memberRole: row.member_role,
    status: row.status,
    joinedAt: row.joined_at,
    endedAt: row.ended_at,
    ...(row.clinic_name
      ? { clinic: { id: row.clinic_id, name: row.clinic_name, city: row.clinic_city } }
      : {}),
    ...(row.member_name ? { member: { fullName: row.member_name, email: row.member_email } } : {}),
  };
}

export const toClinicColumns = (input) => {
  const map = {
    name: 'name',
    registrationNumber: 'registration_number',
    phone: 'phone_e164',
    email: 'email',
    addressLine: 'address_line',
    city: 'city',
    state: 'state',
    postalCode: 'postal_code',
    countryCode: 'country_code',
  };
  return Object.fromEntries(
    Object.entries(map)
      .filter(([field]) => input[field] !== undefined)
      .map(([field, column]) => [column, input[field]]),
  );
};

/** Clinics and memberships are organisational (not patient-scoped) data. */
export function createClinicRepository({ knex }) {
  const db = (trx) => trx ?? knex;
  return {
    async insert(row, trx) {
      await db(trx)('clinics').insert(row);
    },
    findById(id, trx) {
      return db(trx)('clinics').where({ id }).whereNull('deleted_at').first();
    },
    async update(id, patch, trx) {
      return db(trx)('clinics').where({ id }).whereNull('deleted_at').update(patch);
    },
    async list({ status, cursor, limit }) {
      const q = knex('clinics').whereNull('deleted_at');
      if (status) q.where({ status });
      const after = decodeCursor(cursor);
      if (after) q.whereRaw('(created_at, id) < (?::timestamptz, ?::uuid)', [after.t, after.id]);
      const rows = await q
        .orderBy([
          { column: 'created_at', order: 'desc' },
          { column: 'id', order: 'desc' },
        ])
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map(toClinicView),
        nextCursor:
          rows.length > limit && last
            ? encodeCursor({ t: last.created_at.toISOString(), id: last.id })
            : null,
      };
    },

    async insertMembership(row, trx) {
      await db(trx)('clinic_memberships').insert(row);
    },
    findMembershipForUpdate(id, trx) {
      return trx('clinic_memberships').where({ id }).forUpdate().first();
    },
    findMembership(id, trx) {
      return db(trx)('clinic_memberships').where({ id }).first();
    },
    findOpenMembership(clinicId, userId, memberRole, trx) {
      return db(trx)('clinic_memberships')
        .where({ clinic_id: clinicId, user_id: userId, member_role: memberRole })
        .whereIn('status', ['invited', 'active', 'suspended'])
        .first();
    },
    async updateMembership(id, patch, trx) {
      await db(trx)('clinic_memberships').where({ id }).update(patch);
    },
    countActiveAdmins(clinicId, trx) {
      return db(trx)('clinic_memberships')
        .where({ clinic_id: clinicId, member_role: 'CLINIC_ADMIN', status: 'active' })
        .count({ n: '*' })
        .first()
        .then((r) => Number(r.n));
    },
    membersOf(clinicId) {
      return knex('clinic_memberships as m')
        .join('users as u', 'u.id', 'm.user_id')
        .where('m.clinic_id', clinicId)
        .whereNot('m.status', 'ended')
        .select('m.*', 'u.full_name as member_name', 'u.email as member_email')
        .orderBy([{ column: 'm.member_role' }, { column: 'u.full_name' }]);
    },
    membershipsOfUser(userId) {
      return knex('clinic_memberships as m')
        .join('clinics as c', 'c.id', 'm.clinic_id')
        .where('m.user_id', userId)
        .whereNot('m.status', 'ended')
        .whereNull('c.deleted_at')
        .select('m.*', 'c.name as clinic_name', 'c.city as clinic_city')
        .orderBy('c.name');
    },
    /** Active doctor member of an active clinic (used to validate care-relationship context). */
    isActiveDoctorMember(clinicId, userId, trx) {
      return db(trx)('clinic_memberships as m')
        .join('clinics as c', 'c.id', 'm.clinic_id')
        .where({
          'm.clinic_id': clinicId,
          'm.user_id': userId,
          'm.member_role': 'DOCTOR',
          'm.status': 'active',
          'c.status': 'active',
        })
        .whereNull('c.deleted_at')
        .first('m.id')
        .then(Boolean);
    },
  };
}
