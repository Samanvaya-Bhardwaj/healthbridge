import { assertActorTransaction } from '../../core/db/actorContext.js';

export function toCareView(row) {
  return {
    id: row.id,
    patientId: row.patient_id,
    doctorId: row.doctor_id,
    clinicId: row.clinic_id,
    status: row.status,
    initiatedBy: row.initiated_by,
    requestedAt: row.created_at,
    activatedAt: row.activated_at,
    pausedAt: row.paused_at,
    endedAt: row.ended_at,
    endReason: row.end_reason,
    ...(row.doctor_name
      ? {
          doctor: {
            id: row.doctor_id,
            professionalName: row.doctor_name,
            primarySpecialization: row.doctor_specialization,
          },
        }
      : {}),
    ...(row.clinic_name ? { clinic: { id: row.clinic_id, name: row.clinic_name } } : {}),
  };
}

/** care_relationships is patient-scoped: all access requires an actor (RLS) transaction. */
export function createCareRepository() {
  const withDetails = (trx) =>
    trx('care_relationships as cr')
      .join('doctors as d', 'd.id', 'cr.doctor_id')
      .leftJoin('clinics as c', 'c.id', 'cr.clinic_id')
      .select(
        'cr.*',
        'd.professional_name as doctor_name',
        'd.primary_specialization as doctor_specialization',
        'd.user_id as doctor_user_id',
        'c.name as clinic_name',
      );

  return {
    async insert(trx, row) {
      assertActorTransaction(trx);
      await trx('care_relationships').insert(row);
    },
    findById(trx, id) {
      assertActorTransaction(trx);
      return withDetails(trx).where('cr.id', id).first();
    },
    findByIdForUpdate(trx, id) {
      assertActorTransaction(trx);
      return trx('care_relationships').where({ id }).forUpdate().first();
    },
    findOpen(trx, patientId, doctorId) {
      assertActorTransaction(trx);
      return trx('care_relationships')
        .where({ patient_id: patientId, doctor_id: doctorId })
        .whereNot('status', 'ended')
        .first();
    },
    async update(trx, id, patch) {
      assertActorTransaction(trx);
      return trx('care_relationships').where({ id }).update(patch);
    },
    forPatient(trx, patientId, { includeEnded = false } = {}) {
      assertActorTransaction(trx);
      const q = withDetails(trx).where('cr.patient_id', patientId).orderBy('cr.created_at', 'desc');
      if (!includeEnded) q.whereNot('cr.status', 'ended');
      return q;
    },
    forDoctor(trx, doctorId, { status } = {}) {
      assertActorTransaction(trx);
      const q = withDetails(trx)
        .select('cr.patient_display_name')
        .where('cr.doctor_id', doctorId)
        .whereNot('cr.status', 'ended')
        .orderBy('cr.created_at', 'desc')
        .limit(200);
      if (status) q.where('cr.status', status);
      return q;
    },
    /** Resolves an account email to a patient for doctor invitations (no profile data exposed). */
    async patientIdForInvite(trx, email) {
      assertActorTransaction(trx);
      const { rows } = await trx.raw('SELECT authz.patient_id_for_invite(?::citext) AS id', [
        email,
      ]);
      return rows[0]?.id ?? null;
    },
  };
}
