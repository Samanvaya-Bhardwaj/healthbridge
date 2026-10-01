import { assertActorTransaction } from '../../core/db/actorContext.js';

/**
 * Patient-scoped data access. Every method requires an actor (RLS) transaction: the
 * database only returns and accepts rows the acting user is related to.
 */

const FIELD_TO_COLUMN = {
  fullName: 'full_name',
  preferredName: 'preferred_name',
  dateOfBirth: 'date_of_birth',
  sex: 'sex',
  phone: 'phone_e164',
  addressLine: 'address_line',
  city: 'city',
  state: 'state',
  postalCode: 'postal_code',
  countryCode: 'country_code',
  preferredLanguage: 'preferred_language',
  emergencyContactName: 'emergency_contact_name',
  emergencyContactPhone: 'emergency_contact_phone',
  emergencyContactRelationship: 'emergency_contact_relationship',
};

export const PROFILE_FIELDS = Object.keys(FIELD_TO_COLUMN);

/** API fields → column values (only keys present in `input`). */
export function toPatientColumns(input) {
  const row = {};
  for (const [field, column] of Object.entries(FIELD_TO_COLUMN)) {
    if (input[field] !== undefined) row[column] = input[field];
  }
  return row;
}

const isoDate = (value) =>
  value instanceof Date
    ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
    : value;

export function toPatientView(row) {
  const view = { id: row.id };
  for (const [field, column] of Object.entries(FIELD_TO_COLUMN)) view[field] = row[column] ?? null;
  view.dateOfBirth = isoDate(row.date_of_birth);
  view.countryCode = row.country_code?.trim() ?? null;
  view.status = row.status;
  view.hasOwnAccount = Boolean(row.user_id);
  view.isDemo = row.is_demo;
  view.createdAt = row.created_at;
  view.updatedAt = row.updated_at;
  return view;
}

export function toGuardianshipView(row) {
  return {
    id: row.id,
    patientId: row.patient_id,
    guardianUserId: row.guardian_user_id,
    relationshipType: row.relationship_type,
    accessScope: row.access_scope,
    basis: row.basis,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

export function createPatientRepository() {
  return {
    async insert(trx, row) {
      assertActorTransaction(trx);
      await trx('patients').insert(row);
    },

    findById(trx, id) {
      assertActorTransaction(trx);
      return trx('patients').where({ id }).whereNull('deleted_at').first();
    },

    findByUserId(trx, userId) {
      assertActorTransaction(trx);
      return trx('patients').where({ user_id: userId }).whereNull('deleted_at').first();
    },

    async update(trx, id, patch) {
      assertActorTransaction(trx);
      return trx('patients').where({ id }).whereNull('deleted_at').update(patch);
    },

    async insertGuardianship(trx, row) {
      assertActorTransaction(trx);
      await trx('patient_guardianships').insert(row);
    },

    findGuardianship(trx, id) {
      assertActorTransaction(trx);
      return trx('patient_guardianships as g')
        .join('patients as p', 'p.id', 'g.patient_id')
        .where('g.id', id)
        .first('g.*', 'p.user_id as patient_user_id');
    },

    activeGuardianshipsFor(trx, patientId) {
      assertActorTransaction(trx);
      return trx('patient_guardianships')
        .where({ patient_id: patientId, status: 'active' })
        .orderBy('started_at');
    },

    async updateGuardianship(trx, id, patch) {
      assertActorTransaction(trx);
      return trx('patient_guardianships').where({ id }).update(patch);
    },

    /** Dependents the user actively guards, with the guardianship. */
    dependentsOf(trx, guardianUserId) {
      assertActorTransaction(trx);
      return trx('patient_guardianships as g')
        .join('patients as p', 'p.id', 'g.patient_id')
        .where({ 'g.guardian_user_id': guardianUserId, 'g.status': 'active' })
        .whereNull('p.deleted_at')
        .select(
          'p.*',
          'g.id as guardianship_id',
          'g.relationship_type',
          'g.access_scope',
          'g.started_at',
        )
        .orderBy('p.full_name');
    },

    countActiveDependents(trx, guardianUserId) {
      assertActorTransaction(trx);
      return trx('patient_guardianships')
        .where({ guardian_user_id: guardianUserId, status: 'active' })
        .count({ n: '*' })
        .first()
        .then((r) => Number(r.n));
    },
  };
}
