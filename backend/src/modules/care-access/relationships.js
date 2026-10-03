import { PERMISSIONS } from '@healthbridge/shared';
import { actorOf } from '../../core/db/actorContext.js';

/**
 * Relationship resolvers (AccessPolicy gate 2) and the interim consent resolver (gate 3).
 *
 * Relationship types (ADR-0017):
 *   patient_self        the patient's own account
 *   guardian_dependent  an active guardianship (access scope `manage` or `view`)
 *   treating_doctor     verified, active doctor with an ACTIVE care relationship
 *   clinic_member       active member of a clinic through which the patient has an active
 *                       care relationship (recognised, but carries no consent basis)
 *   doctor_party / patient_party / owner / clinic_admin / platform_admin for
 *                       non-patient resources (care relationships, profiles, clinics)
 *
 * Platform admins and support staff have NO relationship to patients: administrative
 * access never implies clinical access.
 *
 * These checks are deliberately written as independent SQL (not the RLS `authz.*`
 * functions) so the application layer and the database layer are separate controls,
 * each tested on its own.
 */

/** Permissions that change patient data or act on the patient's behalf. */
const PATIENT_WRITE_PERMISSIONS = new Set([
  PERMISSIONS.PATIENTS_WRITE,
  PERMISSIONS.DEPENDENTS_MANAGE,
  PERMISSIONS.CARE_RELATIONSHIPS_MANAGE,
  PERMISSIONS.MEDICAL_RECORDS_WRITE,
  PERMISSIONS.APPOINTMENTS_CREATE,
  PERMISSIONS.APPOINTMENTS_MANAGE,
  PERMISSIONS.PAYMENTS_CREATE,
  PERMISSIONS.CONSENTS_MANAGE,
]);

/**
 * Interim basis kept from M2 for backward compatibility (ADR-0021): an ACTIVE care
 * relationship — which the patient explicitly requested or accepted — still allows a
 * treating doctor to read the patient PROFILE (names on schedules). Everything in the
 * medical record requires an explicit consent; this basis never extends to it.
 */
export const CARE_RELATIONSHIP_CONSENT_PERMISSIONS = new Set([PERMISSIONS.PATIENTS_READ]);

/** Permission → the consent scope that must cover it (ADR-0021). */
export const CONSENT_SCOPE_FOR_PERMISSION = Object.freeze({
  [PERMISSIONS.PATIENTS_READ]: 'patient_profile',
  [PERMISSIONS.MEDICAL_RECORDS_READ]: 'medical_documents',
  [PERMISSIONS.MEDICAL_RECORDS_WRITE]: 'medical_documents_upload',
  [PERMISSIONS.LAB_RESULTS_VERIFY]: 'medical_documents',
  [PERMISSIONS.AI_ASSIST_USE]: 'medical_documents',
  // M9: signed prescriptions, as the `prescription` document type.
  [PERMISSIONS.PRESCRIPTIONS_READ]: 'medical_documents',
});

const DOCUMENT_PERMISSIONS = new Set([
  PERMISSIONS.MEDICAL_RECORDS_READ,
  PERMISSIONS.MEDICAL_RECORDS_WRITE,
  PERMISSIONS.LAB_RESULTS_VERIFY,
]);

/**
 * @param {{ knex: import('knex').Knex }} deps  `knex` is used only when no transaction is
 *   supplied (owner-level tests); production code always passes an actor transaction.
 */
export function createCareAccess({ knex }) {
  const dbFor = (principal, trx) => {
    if (trx && actorOf(trx) && actorOf(trx) !== principal.userId) {
      throw new Error('relationship resolution with mismatched actor context');
    }
    return trx ?? knex;
  };

  /** All patient relationships of a user to a patient in one round trip. */
  async function patientRelationships(db, userId, patientId) {
    const result = await db.raw(
      `SELECT
         EXISTS (SELECT 1 FROM patients p
                  WHERE p.id = :patientId AND p.user_id = :userId
                    AND p.deleted_at IS NULL AND p.status = 'active') AS is_self,
         (SELECT g.access_scope FROM patient_guardianships g
            JOIN patients p ON p.id = g.patient_id AND p.deleted_at IS NULL
           WHERE g.patient_id = :patientId AND g.guardian_user_id = :userId AND g.status = 'active'
           ORDER BY (g.access_scope = 'manage') DESC LIMIT 1) AS guardian_scope,
         EXISTS (SELECT 1 FROM care_relationships cr
                   JOIN doctors d ON d.id = cr.doctor_id
                   JOIN users u ON u.id = d.user_id
                  WHERE cr.patient_id = :patientId AND cr.status = 'active' AND d.user_id = :userId
                    AND d.verification_status = 'verified' AND d.profile_status = 'active'
                    AND d.deleted_at IS NULL AND u.status = 'active' AND u.deleted_at IS NULL) AS is_treating,
         EXISTS (SELECT 1 FROM care_relationships cr
                   JOIN clinic_memberships m ON m.clinic_id = cr.clinic_id
                   JOIN clinics c ON c.id = cr.clinic_id
                  WHERE cr.patient_id = :patientId AND cr.status = 'active'
                    AND m.user_id = :userId AND m.status = 'active'
                    AND c.status = 'active' AND c.deleted_at IS NULL) AS is_clinic_member`,
      { patientId, userId },
    );
    return result.rows[0];
  }

  /** @type {import('../../core/authz/accessPolicy.js').RelationshipResolver} */
  async function patientResolver(principal, resource, { permission, trx }) {
    const rel = await patientRelationships(
      dbFor(principal, trx),
      principal.userId,
      resource.patientId,
    );
    if (rel.is_self) return { related: true, relationship: 'patient_self' };
    if (rel.guardian_scope) {
      if (rel.guardian_scope !== 'manage' && PATIENT_WRITE_PERMISSIONS.has(permission)) {
        return { related: false, reason: 'guardian_scope_insufficient' };
      }
      return { related: true, relationship: 'guardian_dependent' };
    }
    if (rel.is_treating) return { related: true, relationship: 'treating_doctor' };
    if (rel.is_clinic_member) return { related: true, relationship: 'clinic_member' };
    return { related: false, reason: 'not_related' };
  }

  /**
   * Care relationship management: the patient side (self, or a guardian; `manage` scope
   * for changes) or the doctor party. `resource` carries patientId-free metadata
   * (`relPatientId`, `doctorUserId`) because relationship metadata is not clinical data.
   */
  async function careRelationshipResolver(principal, resource, { permission, trx }) {
    if (resource.doctorUserId && resource.doctorUserId === principal.userId) {
      return { related: true, relationship: 'doctor_party' };
    }
    const rel = await patientRelationships(
      dbFor(principal, trx),
      principal.userId,
      resource.relPatientId,
    );
    if (rel.is_self) return { related: true, relationship: 'patient_party' };
    if (
      rel.guardian_scope === 'manage' ||
      (rel.guardian_scope && !PATIENT_WRITE_PERMISSIONS.has(permission))
    ) {
      return { related: true, relationship: 'patient_party' };
    }
    return { related: false, reason: 'not_related' };
  }

  /**
   * Appointments: the doctor party, the patient side (self, or a guardian; `manage` scope
   * for changes), or a clinic administrator of the appointment's clinic ("clinic
   * scheduler"). Appointment metadata is scheduling data; the clinical reason for visit
   * is released by the service only to the patient side and the doctor.
   */
  async function appointmentResolver(principal, resource, ctx) {
    if (resource.doctorUserId && resource.doctorUserId === principal.userId) {
      return { related: true, relationship: 'doctor_party' };
    }
    if (resource.relPatientId) {
      const side = await careRelationshipResolver(
        principal,
        { relPatientId: resource.relPatientId },
        ctx,
      );
      if (side.related) return side;
    }
    if (
      resource.clinicId &&
      principal.clinicRoles.some(
        (g) => g.clinicId === resource.clinicId && g.role === 'CLINIC_ADMIN',
      )
    ) {
      return { related: true, relationship: 'clinic_scheduler' };
    }
    return { related: false, reason: 'not_related' };
  }

  /**
   * Explicit consent lookup, evaluated on every request (no cache): an active, unexpired
   * consent to this user, covering the scope (and document type), whose appointment —
   * for appointment-scoped consent — still stands. Independent of the RLS function
   * authz.has_consent, so application and database checks are separate controls.
   */
  async function findConsent(db, { userId, patientId, scope, documentType }) {
    const { rows } = await db.raw(
      `SELECT c.id FROM consents c
        WHERE c.patient_id = :patientId AND c.grantee_user_id = :userId
          AND c.status = 'active' AND c.expires_at > now()
          AND :scope = ANY (c.scopes)
          AND (CAST(:documentType AS text) IS NULL OR c.document_types IS NULL
               OR CAST(:documentType AS text) = ANY (c.document_types))
          AND (c.kind = 'manual' OR EXISTS (
                SELECT 1 FROM appointments a WHERE a.id = c.appointment_id
                   AND a.status NOT IN ('cancelled', 'expired', 'no_show')))
        ORDER BY c.granted_at DESC LIMIT 1`,
      { patientId, userId, scope, documentType: documentType ?? null },
    );
    return rows[0]?.id ?? null;
  }

  /**
   * Medical documents: the patient side, or a treating doctor (consent is checked at
   * gate 3). Resource state is part of the relationship: other parties never relate to
   * a document that is not AVAILABLE, except the uploader completing their own upload.
   * Clinic membership never relates anyone to a document.
   */
  async function medicalDocumentResolver(principal, resource, { permission, trx }) {
    const rel = await patientRelationships(
      dbFor(principal, trx),
      principal.userId,
      resource.patientId,
    );
    if (rel.is_self) return { related: true, relationship: 'patient_self' };
    if (rel.guardian_scope) {
      if (rel.guardian_scope !== 'manage' && PATIENT_WRITE_PERMISSIONS.has(permission)) {
        return { related: false, reason: 'guardian_scope_insufficient' };
      }
      return { related: true, relationship: 'guardian_dependent' };
    }
    if (rel.is_treating && DOCUMENT_PERMISSIONS.has(permission)) {
      const ownUpload =
        permission === PERMISSIONS.MEDICAL_RECORDS_WRITE &&
        resource.uploadedByUserId === principal.userId;
      if (resource.status === 'available' || ownUpload) {
        return { related: true, relationship: 'treating_doctor' };
      }
      return { related: false, reason: 'document_not_available' };
    }
    return { related: false, reason: 'not_related' };
  }

  /** Consents: the patient side manages; the grantee may read the consents they hold. */
  async function consentResolver(principal, resource, { permission, trx }) {
    if (
      permission === PERMISSIONS.CONSENTS_READ &&
      resource.granteeUserId &&
      resource.granteeUserId === principal.userId
    ) {
      return { related: true, relationship: 'grantee' };
    }
    const rel = await patientRelationships(
      dbFor(principal, trx),
      principal.userId,
      resource.relPatientId,
    );
    if (rel.is_self) return { related: true, relationship: 'patient_party' };
    if (
      rel.guardian_scope === 'manage' ||
      (rel.guardian_scope && !PATIENT_WRITE_PERMISSIONS.has(permission))
    ) {
      return { related: true, relationship: 'patient_party' };
    }
    return { related: false, reason: 'not_related' };
  }

  return {
    patientRelationships,
    findConsent,
    resolvers: {
      medical_document: medicalDocumentResolver,
      consent: consentResolver,
      patient: patientResolver,
      care_relationship: careRelationshipResolver,
      appointment: appointmentResolver,
      // A doctor profile is managed only by its owner.
      doctor_profile: (principal, resource) => ({
        related: Boolean(resource.ownerUserId) && resource.ownerUserId === principal.userId,
        relationship: 'owner',
      }),
      // A clinic membership invitation is answered only by the invited user.
      clinic_membership: (principal, resource) => ({
        related: Boolean(resource.memberUserId) && resource.memberUserId === principal.userId,
        relationship: 'owner',
      }),
      // Clinic management: an active clinic-scoped grant for this clinic, or a platform
      // administrator acting through the admin:clinics permission.
      clinic: (principal, resource) => {
        if (principal.clinicRoles.some((g) => g.clinicId === resource.clinicId)) {
          return { related: true, relationship: 'clinic_admin' };
        }
        if (principal.permissions.has(PERMISSIONS.ADMIN_CLINICS)) {
          return { related: true, relationship: 'platform_admin' };
        }
        return { related: false, reason: 'not_clinic_member' };
      },
      guardianship: (principal, resource) => {
        if (resource.guardianUserId === principal.userId) {
          return { related: true, relationship: 'guardian' };
        }
        if (resource.patientUserId && resource.patientUserId === principal.userId) {
          return { related: true, relationship: 'patient_self' };
        }
        return { related: false, reason: 'not_related' };
      },
    },

    /** @type {import('../../core/authz/accessPolicy.js').ConsentResolver} */
    async consentResolver({ principal, patientId, relationship, permission, resource, trx }) {
      if (relationship !== 'treating_doctor') return null;
      const scope = CONSENT_SCOPE_FOR_PERMISSION[permission];
      if (scope) {
        const consentId = await findConsent(dbFor(principal, trx), {
          userId: principal.userId,
          patientId,
          scope,
          documentType: resource?.documentType,
        });
        if (consentId) return { basis: 'consent', consentId };
      }
      if (CARE_RELATIONSHIP_CONSENT_PERMISSIONS.has(permission)) {
        return { basis: 'active_care_relationship', consentId: null };
      }
      return null;
    },
  };
}
