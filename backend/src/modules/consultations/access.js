import { isUuid } from '../../core/db/ids.js';
import { NotFoundError } from '../../core/http/errors.js';

const PARTY = { patient_party: 'patient', doctor_party: 'doctor' };

/**
 * Loads an appointment in the actor transaction and authorises it (AccessPolicy:
 * permission → appointment party). Only the patient side and the appointment's doctor
 * are parties to a consultation; a clinic desk sees schedules, never clinical content.
 *
 * @returns {Promise<{ row: Record<string, any>, party: 'patient'|'doctor' }>}
 */
export async function authorizeConsultationParty(
  { accessPolicy },
  trx,
  principal,
  appointmentId,
  permission,
  req,
  { lock = false } = {},
) {
  if (!isUuid(appointmentId)) throw new NotFoundError();
  const query = trx('appointments as a')
    .join('doctors as d', 'd.id', 'a.doctor_id')
    .leftJoin('clinics as c', 'c.id', 'a.clinic_id')
    .where('a.id', appointmentId);
  if (lock) query.forUpdate('a');
  const row = await query.first(
    'a.*',
    'd.user_id as doctor_user_id',
    'd.professional_name as doctor_name',
    'c.name as clinic_name',
    // Public clinic details, so patients know where to go for an in-clinic visit.
    'c.address_line as clinic_address_line',
    'c.city as clinic_city',
    'c.state as clinic_state',
    'c.postal_code as clinic_postal_code',
    'c.phone_e164 as clinic_phone',
  );
  const decision = await accessPolicy.enforce({
    principal,
    permission,
    resource: {
      type: 'appointment',
      id: appointmentId,
      relPatientId: row?.patient_id,
      doctorUserId: row?.doctor_user_id,
      clinicId: row?.clinic_id ?? undefined,
    },
    req,
    trx,
  });
  const party = PARTY[decision.relationship];
  if (!party) throw new NotFoundError();
  return { row, party };
}
