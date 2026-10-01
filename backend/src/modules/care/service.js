import { PERMISSIONS } from '@healthbridge/shared';
import { isUuid, newId } from '../../core/db/ids.js';
import { withActor } from '../../core/db/actorContext.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../core/http/errors.js';
import { careTransition } from './domain/stateMachine.js';
import { toCareView } from './repository.js';

const DATA = 'data_access';

const isBookableDoctor = (doctor) =>
  doctor && doctor.verification_status === 'verified' && doctor.profile_status === 'active';

/**
 * Care relationships ("My Doctors" / "My Patients"). Relationship rows are patient-scoped
 * (RLS); every action is authorised through AccessPolicy, and every change is audited.
 */
export function createCareService({ knex, care, patients, doctors, clinics, accessPolicy, audit }) {
  const patientResource = (patientId) => ({ type: 'patient', id: patientId, patientId });

  async function ownPatientId(principal, trx) {
    const own = await patients.findByUserId(trx, principal.userId);
    if (!own) throw new NotFoundError('Create your patient profile first.');
    return own.id;
  }

  /** The patient's care team (self or guardian view). */
  async function listForPatient(principal, patientId, req) {
    return withActor(knex, principal.userId, async (trx) => {
      const id = patientId ?? (await ownPatientId(principal, trx));
      if (!isUuid(id)) throw new NotFoundError();
      await accessPolicy.enforce({
        principal,
        permission: PERMISSIONS.CARE_RELATIONSHIPS_READ,
        resource: patientResource(id),
        req,
        trx,
      });
      return (await care.forPatient(trx, id)).map(toCareView);
    });
  }

  /**
   * The doctor's patients. Identifying details of each patient are read only through
   * AccessPolicy (treating-doctor relationship + consent basis), one decision per patient;
   * pending requests show only the name the patient chose to share.
   */
  async function listForDoctor(principal, { status } = {}, req) {
    const doctor = await doctors.findByUserId(principal.userId);
    if (!doctor) throw new NotFoundError('You have not created a doctor profile yet.');
    return withActor(knex, principal.userId, async (trx) => {
      const rows = await care.forDoctor(trx, doctor.id, { status });
      const items = [];
      for (const row of rows) {
        const view = { ...toCareView(row), patient: { displayName: row.patient_display_name } };
        if (row.status === 'active') {
          const decision = await accessPolicy
            .enforce({
              principal,
              permission: PERMISSIONS.PATIENTS_READ,
              resource: patientResource(row.patient_id),
              req,
              trx,
            })
            .catch(() => null);
          const patient = decision ? await patients.findById(trx, row.patient_id) : null;
          if (patient) {
            view.patient = {
              id: patient.id,
              displayName: patient.preferred_name ?? patient.full_name,
              fullName: patient.full_name,
              dateOfBirth: patient.date_of_birth,
              sex: patient.sex,
            };
          }
        }
        items.push(view);
      }
      return items;
    });
  }

  /** A patient (or managing guardian) asks a verified doctor to join their care team. */
  async function request(principal, { patientId, doctorId, clinicId }, req) {
    return withActor(knex, principal.userId, async (trx) => {
      await accessPolicy.enforce({
        principal,
        permission: PERMISSIONS.CARE_RELATIONSHIPS_MANAGE,
        resource: patientResource(patientId),
        req,
        trx,
      });
      const patient = await patients.findById(trx, patientId);
      if (!patient) throw new NotFoundError();
      const doctor = await doctors.findById(doctorId, trx);
      if (!isBookableDoctor(doctor)) throw new NotFoundError('Verified doctor not found.');
      if (patient.user_id && doctor.user_id === patient.user_id) {
        throw new BadRequestError(
          'A doctor cannot add themself as their own doctor.',
          'self_care_relationship',
        );
      }
      if (clinicId && !(await clinics.isActiveDoctorMember(clinicId, doctor.user_id, trx))) {
        throw new BadRequestError(
          'This doctor does not practise at that clinic.',
          'doctor_not_at_clinic',
        );
      }
      if (await care.findOpen(trx, patientId, doctorId)) {
        throw new ConflictError(
          'This doctor is already in, or invited to, your care team.',
          'relationship_exists',
        );
      }
      const id = newId();
      await care.insert(trx, {
        id,
        patient_id: patientId,
        doctor_id: doctorId,
        clinic_id: clinicId ?? null,
        status: 'pending',
        initiated_by: 'patient',
        requested_by_user_id: principal.userId,
        patient_display_name: patient.preferred_name ?? patient.full_name,
      });
      await audit.record(
        {
          category: DATA,
          action: 'care.request',
          outcome: 'success',
          resourceType: 'care_relationship',
          resourceId: id,
          patientId,
          metadata: { doctorId, clinicId: clinicId ?? null },
        },
        { req, trx },
      );
      return toCareView(await care.findById(trx, id));
    });
  }

  /**
   * A verified doctor invites an existing patient by account email. The response never
   * reveals whether the email belongs to a patient (enumeration-safe); the invitation
   * appears in the patient's care team as INVITED.
   */
  async function invite(principal, { email, clinicId }, req) {
    const doctor = await doctors.findByUserId(principal.userId);
    if (!isBookableDoctor(doctor)) {
      throw new ForbiddenError('Only verified doctors can invite patients.', 'doctor_not_verified');
    }
    if (clinicId && !(await clinics.isActiveDoctorMember(clinicId, principal.userId))) {
      throw new BadRequestError('You do not practise at that clinic.', 'doctor_not_at_clinic');
    }
    await withActor(knex, principal.userId, async (trx) => {
      const patientId = await care.patientIdForInvite(trx, email);
      const eligible = patientId && !(await care.findOpen(trx, patientId, doctor.id));
      const id = newId();
      if (eligible) {
        await care.insert(trx, {
          id,
          patient_id: patientId,
          doctor_id: doctor.id,
          clinic_id: clinicId ?? null,
          status: 'invited',
          initiated_by: 'doctor',
          requested_by_user_id: principal.userId,
        });
      }
      await audit.record(
        {
          category: DATA,
          action: 'care.invite',
          outcome: eligible ? 'success' : 'failure',
          resourceType: 'care_relationship',
          resourceId: eligible ? id : null,
          patientId: eligible ? patientId : null,
          reason: eligible ? null : 'no_eligible_patient',
          metadata: { doctorId: doctor.id, clinicId: clinicId ?? null },
        },
        { req, trx },
      );
    });
    return {
      status: 'received',
      message: 'If this email belongs to a HealthBridge patient, they will see your invitation.',
    };
  }

  /** accept | decline | withdraw | pause | resume | end, by the party the rules allow. */
  async function act(principal, relationshipId, action, req) {
    if (!isUuid(relationshipId)) throw new NotFoundError();
    return withActor(knex, principal.userId, async (trx) => {
      const row = await care.findByIdForUpdate(trx, relationshipId);
      const doctor = row ? await doctors.findById(row.doctor_id, trx) : null;
      const decision = await accessPolicy.enforce({
        principal,
        permission: PERMISSIONS.CARE_RELATIONSHIPS_MANAGE,
        resource: {
          type: 'care_relationship',
          id: relationshipId,
          relPatientId: row?.patient_id,
          doctorUserId: doctor?.user_id,
        },
        req,
        trx,
      });
      const party = decision.relationship === 'doctor_party' ? 'doctor' : 'patient';
      const { to, endReason } = careTransition(row.status, action, party);
      if (to === 'active' && !isBookableDoctor(doctor)) {
        throw new ConflictError('The doctor is not currently verified.', 'doctor_not_verified');
      }

      const now = new Date();
      const patch = { status: to };
      if (action === 'accept' || action === 'decline') patch.responded_at = now;
      if (to === 'active' && !row.activated_at) patch.activated_at = now;
      if (to === 'paused') patch.paused_at = now;
      if (action === 'resume') patch.paused_at = null;
      if (to === 'ended')
        Object.assign(patch, {
          ended_at: now,
          ended_by_user_id: principal.userId,
          end_reason: endReason,
        });
      await care.update(trx, relationshipId, patch);

      await audit.record(
        {
          category: DATA,
          action: `care.${action}`,
          outcome: 'success',
          resourceType: 'care_relationship',
          resourceId: relationshipId,
          patientId: row.patient_id,
          metadata: { from: row.status, to, party },
        },
        { req, trx },
      );
      return toCareView(await care.findById(trx, relationshipId));
    });
  }

  return { listForPatient, listForDoctor, request, invite, act };
}
