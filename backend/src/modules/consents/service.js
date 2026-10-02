import {
  ACTIVE_APPOINTMENT_STATUSES,
  APPOINTMENT_CONSENT_GRACE_HOURS,
  PERMISSIONS,
} from '@healthbridge/shared';
import { isUuid, newId } from '../../core/db/ids.js';
import { assertScopedTransaction, withActor, withSystem } from '../../core/db/actorContext.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../core/http/errors.js';
import { domainMetrics } from '../../core/metrics/domain.js';

const PG_UNIQUE_VIOLATION = '23505';
const DATA = 'data_access';

/** Status as the patient and doctor should see it: an elapsed consent is expired. */
export const effectiveStatus = (row, now = new Date()) =>
  row.status === 'active' && new Date(row.expires_at) <= now ? 'expired' : row.status;

export function toConsentView(row, now = new Date()) {
  return {
    id: row.id,
    patientId: row.patient_id,
    patientName: row.patient_name ?? undefined,
    doctor: {
      id: row.grantee_doctor_id,
      professionalName: row.doctor_name,
      primarySpecialization: row.doctor_specialization,
    },
    grantedBy: row.granted_by_relationship === 'guardian' ? 'guardian' : 'patient',
    kind: row.kind,
    appointmentId: row.appointment_id,
    scopes: row.scopes,
    documentTypes: row.document_types,
    purpose: row.purpose,
    status: effectiveStatus(row, now),
    grantedAt: row.granted_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revokeReason: row.revoke_reason,
  };
}

/** Consent rows are visible through RLS to the patient side, the grantee and the system. */
export function createConsentRepository() {
  const base = (trx) =>
    trx('consents as c')
      .join('doctors as d', 'd.id', 'c.grantee_doctor_id')
      .select(
        'c.*',
        'd.professional_name as doctor_name',
        'd.primary_specialization as doctor_specialization',
      );
  return {
    findById(trx, id) {
      assertScopedTransaction(trx);
      return base(trx).where('c.id', id).first();
    },
    forPatient(trx, patientId) {
      assertScopedTransaction(trx);
      return base(trx).where('c.patient_id', patientId).orderBy('c.granted_at', 'desc').limit(200);
    },
    forGrantee(trx, userId) {
      assertScopedTransaction(trx);
      return base(trx)
        .join('patients as p', 'p.id', 'c.patient_id')
        .select(trx.raw('coalesce(p.preferred_name, p.full_name) as patient_name'))
        .where('c.grantee_user_id', userId)
        .orderBy('c.granted_at', 'desc')
        .limit(200);
    },
    async insert(trx, row) {
      assertScopedTransaction(trx);
      await trx('consents').insert(row);
    },
    async update(trx, id, patch) {
      assertScopedTransaction(trx, 'consents');
      return trx('consents').where({ id }).update(patch);
    },
  };
}

/**
 * Consent lifecycle (ADR-0021): grant (patient or managing guardian) → active →
 * revoked (patient side) | expired (time). Every change is audited in the same
 * transaction. Users can only INSERT consent rows; revocation and expiry run as
 * backend-controlled `consents` system transactions after authorisation.
 */
export function createConsentService({
  knex,
  consents,
  doctors,
  appointments,
  careAccess,
  accessPolicy,
  audit,
  now = () => new Date(),
}) {
  const consentResource = (patientId, granteeUserId) => ({
    type: 'consent',
    relPatientId: patientId,
    granteeUserId,
  });

  async function grant(principal, input, req) {
    try {
      return await withActor(knex, principal.userId, async (trx) => {
        await accessPolicy.enforce({
          principal,
          permission: PERMISSIONS.CONSENTS_MANAGE,
          resource: consentResource(input.patientId),
          req,
          trx,
        });
        const doctor = await doctors.findById(input.doctorId, trx);
        if (
          !doctor ||
          doctor.verification_status !== 'verified' ||
          doctor.profile_status !== 'active'
        ) {
          throw new NotFoundError('Verified doctor not found.');
        }
        // Consent goes to doctors in the patient's care team only.
        const rel = await careAccess.patientRelationships(trx, doctor.user_id, input.patientId);
        if (!rel.is_treating) {
          throw new ConflictError(
            'Add this doctor to your care team before sharing records.',
            'care_relationship_required',
          );
        }
        const at = now();
        let expiresAt;
        if (input.kind === 'appointment') {
          const appt = await appointments.findById(trx, input.appointmentId);
          if (
            !appt ||
            appt.patient_id !== input.patientId ||
            appt.doctor_id !== doctor.id ||
            !ACTIVE_APPOINTMENT_STATUSES.includes(appt.status)
          ) {
            throw new ConflictError(
              'Choose an upcoming appointment with this doctor.',
              'appointment_not_eligible',
            );
          }
          expiresAt = new Date(
            new Date(appt.ends_at).getTime() + APPOINTMENT_CONSENT_GRACE_HOURS * 3_600_000,
          );
        } else {
          expiresAt = new Date(at.getTime() + input.expiresInDays * 86_400_000);
        }
        const row = {
          id: newId(),
          patient_id: input.patientId,
          grantee_user_id: doctor.user_id,
          grantee_doctor_id: doctor.id,
          granted_by_user_id: principal.userId,
          granted_by_relationship: await grantedByRelationship(trx, principal, input.patientId),
          kind: input.kind,
          appointment_id: input.appointmentId ?? null,
          scopes: input.scopes,
          document_types: input.documentTypes ?? null,
          purpose: input.purpose,
          granted_at: at,
          expires_at: expiresAt,
        };
        await consents.insert(trx, row);
        await audit.record(
          {
            category: DATA,
            action: 'consent.granted',
            outcome: 'success',
            resourceType: 'consent',
            resourceId: row.id,
            patientId: input.patientId,
            metadata: {
              doctorId: doctor.id,
              kind: row.kind,
              scopes: row.scopes,
              documentTypes: row.document_types,
              purpose: row.purpose,
              expiresAt: row.expires_at,
              grantedBy: row.granted_by_relationship,
            },
          },
          { req, trx },
        );
        domainMetrics.consentGranted.inc({ kind: row.kind });
        return toConsentView(await consents.findById(trx, row.id), at);
      });
    } catch (err) {
      if (err.code === PG_UNIQUE_VIOLATION) {
        throw new ConflictError(
          'This doctor already has an active consent of this kind. Revoke it first to change it.',
          'consent_exists',
        );
      }
      throw err;
    }
  }

  /** The grantor's relationship to the patient, read from the patient record itself. */
  async function grantedByRelationship(trx, principal, patientId) {
    const rel = await careAccess.patientRelationships(trx, principal.userId, patientId);
    return rel.is_self ? 'patient_self' : 'guardian';
  }

  /** Patient side: consents given for a patient. */
  async function listForPatient(principal, patientId, req) {
    if (!isUuid(patientId)) throw new NotFoundError();
    return withActor(knex, principal.userId, async (trx) => {
      const decision = await accessPolicy.enforce({
        principal,
        permission: PERMISSIONS.CONSENTS_READ,
        resource: consentResource(patientId),
        req,
        trx,
      });
      if (decision.relationship !== 'patient_party') throw new ForbiddenError();
      const at = now();
      return (await consents.forPatient(trx, patientId)).map((r) => toConsentView(r, at));
    });
  }

  /** Doctor: consents received (RLS returns only the grantee's own rows). */
  async function listReceived(principal, req) {
    await accessPolicy.enforce({ principal, permission: PERMISSIONS.CONSENTS_READ, req });
    return withActor(knex, principal.userId, async (trx) => {
      const at = now();
      return (await consents.forGrantee(trx, principal.userId)).map((r) => toConsentView(r, at));
    });
  }

  /** Patient or managing guardian revokes. Takes effect on the very next request. */
  async function revoke(principal, id, { reasonCode }, req) {
    if (!isUuid(id)) throw new NotFoundError();
    const row = await withActor(knex, principal.userId, async (trx) => {
      const found = await consents.findById(trx, id);
      await accessPolicy.enforce({
        principal,
        permission: PERMISSIONS.CONSENTS_MANAGE,
        resource: consentResource(found?.patient_id, undefined),
        req,
        trx,
      });
      return found;
    });
    return withSystem(knex, 'consents', async (trx) => {
      const current = await consents.findById(trx, row.id);
      if (effectiveStatus(current, now()) !== 'active') {
        throw new ConflictError('This consent is no longer active.', 'consent_not_active');
      }
      const at = now();
      const changed = await consents.update(trx, row.id, {
        status: 'revoked',
        revoked_at: at,
        revoked_by_user_id: principal.userId,
        revoke_reason: reasonCode,
      });
      if (changed !== 1)
        throw new ConflictError('This consent is no longer active.', 'consent_not_active');
      await audit.record(
        {
          category: DATA,
          action: 'consent.revoked',
          outcome: 'success',
          actor: principal,
          resourceType: 'consent',
          resourceId: row.id,
          patientId: row.patient_id,
          reason: reasonCode,
          metadata: { doctorId: row.grantee_doctor_id, kind: row.kind },
        },
        { req, trx },
      );
      domainMetrics.consentRevoked.inc({ cause: 'revoked' });
      return toConsentView(
        { ...current, status: 'revoked', revoked_at: at, revoke_reason: reasonCode },
        at,
      );
    });
  }

  /** Housekeeping: records the `expired` status (access already stopped at expiry). */
  async function expireDue({ limit = 500 } = {}) {
    return withSystem(knex, 'consents', async (trx) => {
      const rows = await trx('consents')
        .where({ status: 'active' })
        .where('expires_at', '<=', trx.fn.now())
        .limit(limit)
        .forUpdate()
        .skipLocked();
      for (const row of rows) {
        await consents.update(trx, row.id, { status: 'expired', expired_at: trx.fn.now() });
        await audit.record(
          {
            category: DATA,
            action: 'consent.expired',
            outcome: 'success',
            actor: 'system',
            resourceType: 'consent',
            resourceId: row.id,
            patientId: row.patient_id,
            metadata: { doctorId: row.grantee_doctor_id, kind: row.kind },
          },
          { trx },
        );
        domainMetrics.consentRevoked.inc({ cause: 'expired' });
      }
      return { expired: rows.length };
    });
  }

  return { grant, listForPatient, listReceived, revoke, expireDue };
}
