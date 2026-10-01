import { decodeCursor, encodeCursor } from '../../core/http/pagination.js';

const FIELD_TO_COLUMN = {
  professionalName: 'professional_name',
  registrationNumber: 'registration_number',
  registrationCouncil: 'registration_council',
  registrationYear: 'registration_year',
  primarySpecialization: 'primary_specialization',
  additionalSpecializations: 'additional_specializations',
  qualifications: 'qualifications',
  yearsOfExperience: 'years_of_experience',
  languages: 'languages',
  bio: 'bio',
};

export function toDoctorColumns(input) {
  const row = {};
  for (const [field, column] of Object.entries(FIELD_TO_COLUMN)) {
    if (input[field] === undefined) continue;
    row[column] = column === 'qualifications' ? JSON.stringify(input[field]) : input[field];
  }
  return row;
}

/** Full view for the doctor themself and administrators. */
export function toDoctorView(row) {
  return {
    id: row.id,
    userId: row.user_id,
    professionalName: row.professional_name,
    registrationNumber: row.registration_number,
    registrationCouncil: row.registration_council,
    registrationYear: row.registration_year,
    primarySpecialization: row.primary_specialization,
    additionalSpecializations: row.additional_specializations,
    qualifications: row.qualifications,
    yearsOfExperience: row.years_of_experience,
    languages: row.languages,
    bio: row.bio,
    profileStatus: row.profile_status,
    verificationStatus: row.verification_status,
    verifiedAt: row.verified_at,
    isDemo: row.is_demo,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Public directory view (verified, active doctors only). */
export function toPublicDoctorView(row) {
  return {
    id: row.id,
    professionalName: row.professional_name,
    primarySpecialization: row.primary_specialization,
    additionalSpecializations: row.additional_specializations,
    qualifications: row.qualifications,
    yearsOfExperience: row.years_of_experience,
    languages: row.languages,
    bio: row.bio,
    registrationCouncil: row.registration_council,
    registrationNumber: row.registration_number,
    verified: row.verification_status === 'verified',
    clinics: row.clinics ?? [],
  };
}

export function toVerificationView(row) {
  return {
    id: row.id,
    doctorId: row.doctor_id,
    status: row.status,
    registrationNumber: row.registration_number,
    registrationCouncil: row.registration_council,
    registrationYear: row.registration_year,
    submittedAt: row.submitted_at,
    reviewerUserId: row.reviewer_user_id,
    reviewStartedAt: row.review_started_at,
    decidedByUserId: row.decided_by_user_id,
    decidedAt: row.decided_at,
    decisionReasonCode: row.decision_reason_code,
    decisionNotes: row.decision_notes,
    ...(row.professional_name
      ? {
          doctor: {
            professionalName: row.professional_name,
            primarySpecialization: row.primary_specialization,
          },
        }
      : {}),
  };
}

const ACTIVE_CLINICS = (knex) =>
  knex.raw(
    `COALESCE((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'city', c.city) ORDER BY c.name)
                 FROM clinic_memberships m JOIN clinics c ON c.id = m.clinic_id
                WHERE m.user_id = doctors.user_id AND m.member_role = 'DOCTOR' AND m.status = 'active'
                  AND c.status = 'active' AND c.deleted_at IS NULL), '[]') AS clinics`,
  );

/** Doctors are professional (not patient-scoped) data: no RLS on these tables. */
export function createDoctorRepository({ knex }) {
  const db = (trx) => trx ?? knex;

  return {
    async insert(row, trx) {
      await db(trx)('doctors').insert(row);
    },
    findById(id, trx) {
      return db(trx)('doctors').where({ id }).whereNull('deleted_at').first();
    },
    findByIdForUpdate(id, trx) {
      return trx('doctors').where({ id }).whereNull('deleted_at').forUpdate().first();
    },
    findByUserId(userId, trx) {
      return db(trx)('doctors').where({ user_id: userId }).whereNull('deleted_at').first();
    },
    async update(id, patch, trx) {
      return db(trx)('doctors').where({ id }).update(patch);
    },
    registrationTaken(council, number, exceptId, trx) {
      const q = db(trx)('doctors')
        .where({ registration_council: council, registration_number: number })
        .whereNull('deleted_at');
      if (exceptId) q.whereNot({ id: exceptId });
      return q.first('id');
    },

    findPublic(id) {
      return knex('doctors')
        .select('doctors.*', ACTIVE_CLINICS(knex))
        .where({ id, profile_status: 'active', verification_status: 'verified' })
        .whereNull('deleted_at')
        .first();
    },

    /** Directory of verified, active doctors (keyset pagination by name). */
    async listDirectory({ q, specialization, clinicId, cursor, limit }) {
      const query = knex('doctors')
        .select('doctors.*', ACTIVE_CLINICS(knex))
        .where({ profile_status: 'active', verification_status: 'verified' })
        .whereNull('deleted_at');
      if (specialization) query.whereILike('primary_specialization', specialization);
      if (q) {
        const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        query.where((w) =>
          w
            .whereILike('professional_name', pattern)
            .orWhereILike('primary_specialization', pattern),
        );
      }
      if (clinicId) {
        query.whereExists(
          knex('clinic_memberships')
            .whereRaw('clinic_memberships.user_id = doctors.user_id')
            .where({ clinic_id: clinicId, member_role: 'DOCTOR', status: 'active' }),
        );
      }
      const after = decodeCursor(cursor);
      if (after) query.whereRaw('(professional_name, id) > (?, ?::uuid)', [after.n, after.id]);
      const rows = await query
        .orderBy([{ column: 'professional_name' }, { column: 'id' }])
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map(toPublicDoctorView),
        nextCursor:
          rows.length > limit && last
            ? encodeCursor({ n: last.professional_name, id: last.id })
            : null,
      };
    },

    // ── Verification cases ────────────────────────────────────────
    async insertCase(row, trx) {
      await db(trx)('doctor_verifications').insert(row);
    },
    findCaseForUpdate(id, trx) {
      return trx('doctor_verifications').where({ id }).forUpdate().first();
    },
    findCase(id) {
      return knex('doctor_verifications as v')
        .join('doctors as d', 'd.id', 'v.doctor_id')
        .where('v.id', id)
        .first(
          'v.*',
          'd.professional_name',
          'd.primary_specialization',
          'd.user_id as doctor_user_id',
        );
    },
    async updateCase(id, patch, trx) {
      await db(trx)('doctor_verifications').where({ id }).update(patch);
    },
    casesForDoctor(doctorId) {
      return knex('doctor_verifications')
        .where({ doctor_id: doctorId })
        .orderBy('submitted_at', 'desc');
    },
    queue({ status, limit }) {
      const q = knex('doctor_verifications as v')
        .join('doctors as d', 'd.id', 'v.doctor_id')
        .select('v.*', 'd.professional_name', 'd.primary_specialization')
        .orderBy('v.submitted_at', 'asc')
        .limit(limit);
      if (status) q.where('v.status', status);
      else q.whereIn('v.status', ['pending', 'under_review']);
      return q;
    },
  };
}
