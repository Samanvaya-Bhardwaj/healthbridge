import { PERMISSIONS, ROLES } from '@healthbridge/shared';
import { isUuid, newId } from '../../core/db/ids.js';
import { hasPermission } from '../../core/authz/principal.js';
import { ConflictError, NotFoundError } from '../../core/http/errors.js';
import { toClinicColumns, toClinicView, toMembershipView } from './repository.js';

const ADMIN = 'administration';

/**
 * Clinics, memberships and clinic-scoped roles (ADR-0017).
 *
 * - A doctor may be a member of many clinics; a user may administer many clinics.
 * - Clinic-scoped permissions (e.g. clinic:manage) apply only to the clinic of the grant.
 * - A clinic-scoped role is in force only while the matching membership is ACTIVE and the
 *   clinic is active (enforced by the effective_role_grants view).
 * - Clinic membership never grants access to patients by itself.
 */
export function createClinicService({ knex, clinics, users, roles, doctors, accessPolicy, audit }) {
  async function requireClinic(clinicId, trx) {
    const clinic = isUuid(clinicId) ? await clinics.findById(clinicId, trx) : null;
    if (!clinic) throw new NotFoundError();
    return clinic;
  }

  /** Clinic management: clinic admins for their own clinic, or platform admins. */
  async function authorizeManagement(principal, clinicId, req) {
    const platform = hasPermission(principal, PERMISSIONS.ADMIN_CLINICS);
    return accessPolicy.enforce({
      principal,
      permission: platform ? PERMISSIONS.ADMIN_CLINICS : PERMISSIONS.CLINIC_MANAGE,
      resource: { type: 'clinic', id: clinicId, clinicId },
      req,
    });
  }

  async function createClinic(principal, input, req) {
    return knex.transaction(async (trx) => {
      const id = newId();
      await clinics.insert(
        { id, created_by_user_id: principal.userId, ...toClinicColumns(input) },
        trx,
      );
      await audit.record(
        {
          category: ADMIN,
          action: 'admin.clinic_create',
          outcome: 'success',
          resourceType: 'clinic',
          resourceId: id,
        },
        { req, trx },
      );
      return toClinicView(await clinics.findById(id, trx));
    });
  }

  const listClinics = (filter) => clinics.list(filter);

  async function getClinic(clinicId) {
    const clinic = await requireClinic(clinicId);
    return toClinicView(clinic);
  }

  async function setClinicStatus(principal, clinicId, status, req) {
    return knex.transaction(async (trx) => {
      await requireClinic(clinicId, trx);
      await clinics.update(clinicId, { status }, trx);
      await audit.record(
        {
          category: ADMIN,
          action: 'admin.clinic_status_update',
          outcome: 'success',
          resourceType: 'clinic',
          resourceId: clinicId,
          metadata: { status },
        },
        { req, trx },
      );
      return toClinicView(await clinics.findById(clinicId, trx));
    });
  }

  /** Appoints a clinic administrator: an active membership plus the clinic-scoped role. */
  async function appointAdmin(principal, clinicId, userId, req) {
    return knex.transaction(async (trx) => {
      const clinic = await requireClinic(clinicId, trx);
      if (clinic.status !== 'active')
        throw new ConflictError('The clinic is inactive.', 'clinic_inactive');
      const user = isUuid(userId) ? await users.findById(userId, trx) : null;
      if (!user || user.status !== 'active') throw new NotFoundError('User not found.');
      let membership = await clinics.findOpenMembership(clinicId, userId, ROLES.CLINIC_ADMIN, trx);
      if (!membership) {
        const id = newId();
        await clinics.insertMembership(
          {
            id,
            clinic_id: clinicId,
            user_id: userId,
            member_role: ROLES.CLINIC_ADMIN,
            status: 'active',
            joined_at: new Date(),
            invited_by_user_id: principal.userId,
          },
          trx,
        );
        membership = await clinics.findMembership(id, trx);
      } else if (membership.status !== 'active') {
        await clinics.updateMembership(
          membership.id,
          { status: 'active', joined_at: new Date() },
          trx,
        );
      }
      await roles.grant(userId, ROLES.CLINIC_ADMIN, principal.userId, trx, { clinicId });
      await audit.record(
        {
          category: ADMIN,
          action: 'clinic.admin_appoint',
          outcome: 'success',
          resourceType: 'clinic_membership',
          resourceId: membership.id,
          metadata: { clinicId, memberUserId: userId },
        },
        { req, trx },
      );
      return toMembershipView(await clinics.findMembership(membership.id, trx));
    });
  }

  async function listMembers(principal, clinicId, req) {
    // Authorise before looking the clinic up, so existence is not revealed to outsiders.
    await authorizeManagement(principal, clinicId, req);
    await requireClinic(clinicId);
    return (await clinics.membersOf(clinicId)).map(toMembershipView);
  }

  /** Invites a verified doctor to practise at the clinic (doctor must accept). */
  async function inviteDoctor(principal, clinicId, doctorId, req) {
    await authorizeManagement(principal, clinicId, req);
    return knex.transaction(async (trx) => {
      const clinic = await requireClinic(clinicId, trx);
      if (clinic.status !== 'active')
        throw new ConflictError('The clinic is inactive.', 'clinic_inactive');
      const doctor = isUuid(doctorId) ? await doctors.findById(doctorId, trx) : null;
      if (
        !doctor ||
        doctor.verification_status !== 'verified' ||
        doctor.profile_status !== 'active'
      ) {
        throw new NotFoundError('Verified doctor not found.');
      }
      if (await clinics.findOpenMembership(clinicId, doctor.user_id, ROLES.DOCTOR, trx)) {
        throw new ConflictError(
          'This doctor is already a member or has a pending invitation.',
          'membership_exists',
        );
      }
      const id = newId();
      await clinics.insertMembership(
        {
          id,
          clinic_id: clinicId,
          user_id: doctor.user_id,
          member_role: ROLES.DOCTOR,
          status: 'invited',
          invited_by_user_id: principal.userId,
        },
        trx,
      );
      await audit.record(
        {
          category: ADMIN,
          action: 'clinic.doctor_invite',
          outcome: 'success',
          resourceType: 'clinic_membership',
          resourceId: id,
          metadata: { clinicId, doctorId },
        },
        { req, trx },
      );
      return toMembershipView(await clinics.findMembership(id, trx));
    });
  }

  /** The invited user accepts or declines their own clinic invitation. */
  async function respondToInvitation(principal, membershipId, accept, req) {
    if (!isUuid(membershipId)) throw new NotFoundError();
    return knex.transaction(async (trx) => {
      const membership = await clinics.findMembershipForUpdate(membershipId, trx);
      await accessPolicy.enforce({
        principal,
        permission: PERMISSIONS.DOCTOR_PROFILE_MANAGE,
        resource: {
          type: 'clinic_membership',
          id: membershipId,
          memberUserId: membership?.user_id,
        },
        req,
      });
      if (membership.status !== 'invited') {
        throw new ConflictError('This invitation is no longer open.', 'invitation_closed');
      }
      const now = new Date();
      await clinics.updateMembership(
        membershipId,
        accept
          ? { status: 'active', joined_at: now }
          : { status: 'ended', ended_at: now, end_reason: 'declined' },
        trx,
      );
      await audit.record(
        {
          category: ADMIN,
          action: accept ? 'clinic.membership_accept' : 'clinic.membership_decline',
          outcome: 'success',
          resourceType: 'clinic_membership',
          resourceId: membershipId,
          metadata: { clinicId: membership.clinic_id },
        },
        { req, trx },
      );
      return toMembershipView(await clinics.findMembership(membershipId, trx));
    });
  }

  /**
   * Ends a membership: by clinic management, or by the member leaving. Ending a clinic
   * administrator membership removes the clinic-scoped role; the last administrator of
   * an active clinic cannot remove themself (a platform admin can).
   */
  async function endMembership(principal, clinicId, membershipId, req) {
    if (!isUuid(membershipId)) throw new NotFoundError();
    return knex.transaction(async (trx) => {
      const membership = await clinics.findMembershipForUpdate(membershipId, trx);
      if (!membership || membership.clinic_id !== clinicId) throw new NotFoundError();
      const leavingSelf = membership.user_id === principal.userId;
      if (!leavingSelf) await authorizeManagement(principal, clinicId, req);
      if (membership.status === 'ended')
        throw new ConflictError('Membership already ended.', 'already_ended');

      if (membership.member_role === ROLES.CLINIC_ADMIN && membership.status === 'active') {
        const platform = hasPermission(principal, PERMISSIONS.ADMIN_CLINICS);
        if (!platform && (await clinics.countActiveAdmins(clinicId, trx)) <= 1) {
          throw new ConflictError(
            'A clinic must keep at least one administrator.',
            'last_clinic_admin',
          );
        }
        await roles.revoke(membership.user_id, ROLES.CLINIC_ADMIN, trx, { clinicId });
      }
      await clinics.updateMembership(
        membershipId,
        {
          status: 'ended',
          ended_at: new Date(),
          end_reason: leavingSelf ? 'member_left' : 'removed',
        },
        trx,
      );
      await audit.record(
        {
          category: ADMIN,
          action: 'clinic.membership_end',
          outcome: 'success',
          resourceType: 'clinic_membership',
          resourceId: membershipId,
          metadata: { clinicId, memberRole: membership.member_role, leftVoluntarily: leavingSelf },
        },
        { req, trx },
      );
      return toMembershipView(await clinics.findMembership(membershipId, trx));
    });
  }

  async function myMemberships(principal) {
    return (await clinics.membershipsOfUser(principal.userId)).map(toMembershipView);
  }

  return {
    createClinic,
    listClinics,
    getClinic,
    setClinicStatus,
    appointAdmin,
    listMembers,
    inviteDoctor,
    respondToInvitation,
    endMembership,
    myMemberships,
  };
}
