import { DOCTOR_REGISTRATION_FIELDS, PERMISSIONS, ROLES } from '@healthbridge/shared';
import { isUuid, newId } from '../../core/db/ids.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../core/http/errors.js';
import { REGISTRATION_LOCKED_STATUSES, nextVerificationStatus } from './domain/verification.js';
import {
  toDoctorColumns,
  toDoctorView,
  toPublicDoctorView,
  toVerificationView,
} from './repository.js';

const ADMIN = 'administration';
const ACCOUNT = 'account';

/**
 * Doctor profiles (separate from the user account) and credential verification
 * (separate from the profile). The DOCTOR role is granted only by a verification
 * decision and removed on suspension.
 */
export function createDoctorService({ knex, doctors, roles, accessPolicy, audit }) {
  async function requireOwnProfile(principal, trx) {
    const doctor = await doctors.findByUserId(principal.userId, trx);
    if (!doctor) throw new NotFoundError('You have not created a doctor profile yet.');
    await accessPolicy.enforce({
      principal,
      permission: PERMISSIONS.DOCTOR_PROFILE_MANAGE,
      resource: { type: 'doctor_profile', id: doctor.id, ownerUserId: doctor.user_id },
    });
    return doctor;
  }

  async function assertRegistrationAvailable(input, exceptId, trx) {
    if (!input.registrationNumber && !input.registrationCouncil) return;
    const taken = await doctors.registrationTaken(
      input.registrationCouncil,
      input.registrationNumber,
      exceptId,
      trx,
    );
    if (taken) {
      throw new ConflictError(
        'This registration number is already associated with a HealthBridge profile.',
        'registration_in_use',
      );
    }
  }

  async function createOwnProfile(principal, input, req, { isDemo = false } = {}) {
    return knex.transaction(async (trx) => {
      if (await doctors.findByUserId(principal.userId, trx)) {
        throw new ConflictError('You already have a doctor profile.', 'doctor_profile_exists');
      }
      await assertRegistrationAvailable(input, null, trx);
      const id = newId();
      await doctors.insert(
        { id, user_id: principal.userId, is_demo: isDemo, ...toDoctorColumns(input) },
        trx,
      );
      await audit.record(
        {
          category: ACCOUNT,
          action: 'doctor.profile_create',
          outcome: 'success',
          resourceType: 'doctor',
          resourceId: id,
        },
        { req, trx },
      );
      return toDoctorView(await doctors.findById(id, trx));
    });
  }

  async function getOwnProfile(principal) {
    return toDoctorView(await requireOwnProfile(principal));
  }

  async function updateOwnProfile(principal, patch, req) {
    return knex.transaction(async (trx) => {
      const doctor = await requireOwnProfile(principal, trx);
      const touchesRegistration = DOCTOR_REGISTRATION_FIELDS.some((f) => patch[f] !== undefined);
      if (touchesRegistration && REGISTRATION_LOCKED_STATUSES.has(doctor.verification_status)) {
        throw new ConflictError(
          'Registration details cannot change while under review or after verification.',
          'registration_locked',
        );
      }
      if (touchesRegistration) {
        await assertRegistrationAvailable(
          {
            registrationCouncil: patch.registrationCouncil ?? doctor.registration_council,
            registrationNumber: patch.registrationNumber ?? doctor.registration_number,
          },
          doctor.id,
          trx,
        );
      }
      await doctors.update(doctor.id, toDoctorColumns(patch), trx);
      await audit.record(
        {
          category: ACCOUNT,
          action: 'doctor.profile_update',
          outcome: 'success',
          resourceType: 'doctor',
          resourceId: doctor.id,
          metadata: { fields: Object.keys(patch) },
        },
        { req, trx },
      );
      return toDoctorView(await doctors.findById(doctor.id, trx));
    });
  }

  /** Submits (or resubmits) the profile's registration details for verification. */
  async function submitForVerification(principal, req) {
    return knex.transaction(async (trx) => {
      const own = await requireOwnProfile(principal, trx);
      const doctor = await doctors.findByIdForUpdate(own.id, trx);
      const next = nextVerificationStatus(doctor.verification_status, 'submit');
      const caseId = newId();
      await doctors.insertCase(
        {
          id: caseId,
          doctor_id: doctor.id,
          status: 'pending',
          registration_number: doctor.registration_number,
          registration_council: doctor.registration_council,
          registration_year: doctor.registration_year,
          submitted_by_user_id: principal.userId,
          submitted_at: new Date(),
        },
        trx,
      );
      await doctors.update(doctor.id, { verification_status: next }, trx);
      await audit.record(
        {
          category: ACCOUNT,
          action: 'doctor.verification_submit',
          outcome: 'success',
          resourceType: 'doctor_verification',
          resourceId: caseId,
          metadata: { doctorId: doctor.id, previousStatus: doctor.verification_status },
        },
        { req, trx },
      );
      return toVerificationView({
        ...(await trx('doctor_verifications').where({ id: caseId }).first()),
      });
    });
  }

  async function verificationHistory(principal) {
    const doctor = await requireOwnProfile(principal);
    return (await doctors.casesForDoctor(doctor.id)).map((row) => {
      // Internal reviewer notes are for administrators only.
      const {
        decisionNotes: _notes,
        reviewerUserId: _r,
        decidedByUserId: _d,
        ...view
      } = toVerificationView(row);
      return view;
    });
  }

  // ── Administration ────────────────────────────────────────────────

  async function verificationQueue({ status, limit }) {
    return (await doctors.queue({ status, limit })).map(toVerificationView);
  }

  async function getCase(caseId, req) {
    if (!isUuid(caseId)) throw new NotFoundError();
    const row = await doctors.findCase(caseId);
    if (!row) throw new NotFoundError();
    await audit.record(
      {
        category: ADMIN,
        action: 'admin.doctor_verification_read',
        outcome: 'success',
        resourceType: 'doctor_verification',
        resourceId: caseId,
      },
      { req },
    );
    return {
      ...toVerificationView(row),
      doctorProfile: toDoctorView(await doctors.findById(row.doctor_id)),
    };
  }

  async function lockCase(caseId, principal, trx) {
    if (!isUuid(caseId)) throw new NotFoundError();
    const kase = await doctors.findCaseForUpdate(caseId, trx);
    if (!kase) throw new NotFoundError();
    const doctor = await doctors.findByIdForUpdate(kase.doctor_id, trx);
    // Separation of duties: nobody reviews their own credentials.
    if (doctor.user_id === principal.userId) {
      throw new ForbiddenError('You cannot review your own verification.', 'self_review');
    }
    return { kase, doctor };
  }

  async function startReview(principal, caseId, req) {
    return knex.transaction(async (trx) => {
      const { kase, doctor } = await lockCase(caseId, principal, trx);
      if (kase.status !== 'pending') {
        throw new ConflictError(
          'Only pending verifications can be taken into review.',
          'invalid_verification_transition',
        );
      }
      const next = nextVerificationStatus(doctor.verification_status, 'start_review');
      await doctors.updateCase(
        kase.id,
        {
          status: 'under_review',
          reviewer_user_id: principal.userId,
          review_started_at: new Date(),
        },
        trx,
      );
      await doctors.update(doctor.id, { verification_status: next }, trx);
      await audit.record(
        {
          category: ADMIN,
          action: 'admin.doctor_verification_review_start',
          outcome: 'success',
          resourceType: 'doctor_verification',
          resourceId: kase.id,
          metadata: { doctorId: doctor.id },
        },
        { req, trx },
      );
      return toVerificationView(await trx('doctor_verifications').where({ id: kase.id }).first());
    });
  }

  /**
   * Approve or reject. Approval activates the profile and grants the DOCTOR role in the
   * same transaction; rejection leaves the doctor without clinical capabilities.
   */
  async function decide(principal, caseId, { decision, reasonCode, notes }, req) {
    return knex.transaction(async (trx) => {
      const { kase, doctor } = await lockCase(caseId, principal, trx);
      if (kase.status !== 'under_review') {
        throw new ConflictError(
          'Take the verification into review before deciding.',
          'invalid_verification_transition',
        );
      }
      const next = nextVerificationStatus(
        doctor.verification_status,
        decision === 'verified' ? 'verify' : 'reject',
      );
      const now = new Date();
      await doctors.updateCase(
        kase.id,
        {
          status: next,
          decided_by_user_id: principal.userId,
          decided_at: now,
          decision_reason_code: reasonCode,
          decision_notes: notes ?? null,
        },
        trx,
      );
      if (next === 'verified') {
        await doctors.update(
          doctor.id,
          { verification_status: 'verified', verified_at: now, profile_status: 'active' },
          trx,
        );
        await roles.grant(doctor.user_id, ROLES.DOCTOR, principal.userId, trx);
      } else {
        await doctors.update(doctor.id, { verification_status: 'rejected' }, trx);
      }
      await audit.record(
        {
          category: ADMIN,
          action: 'admin.doctor_verification_decision',
          outcome: 'success',
          resourceType: 'doctor_verification',
          resourceId: kase.id,
          reason: reasonCode,
          // Notes are never copied into the audit trail.
          metadata: { doctorId: doctor.id, decision: next, roleGranted: next === 'verified' },
        },
        { req, trx },
      );
      return toVerificationView(await trx('doctor_verifications').where({ id: kase.id }).first());
    });
  }

  /** Suspends a verified doctor: profile hidden, DOCTOR role removed, treating access ends. */
  async function suspend(principal, doctorId, { reasonCode, notes }, req) {
    if (!isUuid(doctorId)) throw new NotFoundError();
    return knex.transaction(async (trx) => {
      const doctor = await doctors.findByIdForUpdate(doctorId, trx);
      if (!doctor) throw new NotFoundError();
      if (doctor.user_id === principal.userId) {
        throw new ForbiddenError('You cannot suspend your own doctor profile.', 'self_review');
      }
      const next = nextVerificationStatus(doctor.verification_status, 'suspend');
      const now = new Date();
      const caseId = newId();
      await doctors.insertCase(
        {
          id: caseId,
          doctor_id: doctor.id,
          status: 'suspended',
          registration_number: doctor.registration_number,
          registration_council: doctor.registration_council,
          registration_year: doctor.registration_year,
          submitted_by_user_id: principal.userId,
          submitted_at: now,
          decided_by_user_id: principal.userId,
          decided_at: now,
          decision_reason_code: reasonCode,
          decision_notes: notes ?? null,
        },
        trx,
      );
      await doctors.update(
        doctor.id,
        { verification_status: next, profile_status: 'suspended' },
        trx,
      );
      const roleRemoved = await roles.revoke(doctor.user_id, ROLES.DOCTOR, trx);
      await audit.record(
        {
          category: ADMIN,
          action: 'admin.doctor_suspend',
          outcome: 'success',
          resourceType: 'doctor',
          resourceId: doctor.id,
          reason: reasonCode,
          metadata: { caseId, roleRemoved },
        },
        { req, trx },
      );
      return toDoctorView(await doctors.findById(doctor.id, trx));
    });
  }

  // ── Directory ─────────────────────────────────────────────────────

  async function directory(filter) {
    return doctors.listDirectory(filter);
  }

  async function publicProfile(doctorId) {
    if (!isUuid(doctorId)) throw new NotFoundError();
    const row = await doctors.findPublic(doctorId);
    if (!row) throw new NotFoundError();
    return toPublicDoctorView(row);
  }

  return {
    createOwnProfile,
    getOwnProfile,
    updateOwnProfile,
    submitForVerification,
    verificationHistory,
    verificationQueue,
    getCase,
    startReview,
    decide,
    suspend,
    directory,
    publicProfile,
  };
}
