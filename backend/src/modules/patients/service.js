import { PERMISSIONS, patientProfileSchema } from '@healthbridge/shared';
import { newId, isUuid } from '../../core/db/ids.js';
import { withActor } from '../../core/db/actorContext.js';
import { ConflictError, NotFoundError, ValidationError } from '../../core/http/errors.js';
import {
  PROFILE_FIELDS,
  toGuardianshipView,
  toPatientColumns,
  toPatientView,
} from './repository.js';

const MAX_DEPENDENTS = 10;

const patientResource = (patientId) => ({ type: 'patient', id: patientId, patientId });

/**
 * Patient profiles, dependents and guardianships.
 *
 * Authorisation: every read or write of patient data goes through AccessPolicy
 * (three gates) inside an actor (RLS) transaction, so the database enforces the same
 * boundary independently. If AccessPolicy allows but RLS hides a row, the layers
 * disagree: the request fails closed (404) and the discrepancy is logged.
 */
export function createPatientService({ knex, patients, accessPolicy, audit, logger }) {
  function rowOrMismatch(row, patientId, principal) {
    if (row) return row;
    logger.warn(
      { patientId, userId: principal.userId },
      'authorization layers disagree: RLS hid an allowed patient',
    );
    throw new NotFoundError();
  }

  /** Validates the merged profile so partial updates cannot violate invariants. */
  function validateMerged(current, patch) {
    const merged = { ...toPatientView(current), ...patch };
    const candidate = Object.fromEntries(PROFILE_FIELDS.map((f) => [f, merged[f] ?? undefined]));
    const result = patientProfileSchema.safeParse(candidate);
    if (!result.success) {
      throw new ValidationError(
        result.error.issues.map((i) => ({ path: `body.${i.path.join('.')}`, message: i.message })),
      );
    }
  }

  /** `options.isDemo` is used only by the synthetic demo seed. */
  async function createOwnProfile(principal, input, req, { isDemo = false } = {}) {
    return withActor(knex, principal.userId, async (trx) => {
      if (await patients.findByUserId(trx, principal.userId)) {
        throw new ConflictError('You already have a patient profile.', 'patient_profile_exists');
      }
      const id = newId();
      await patients.insert(trx, {
        id,
        user_id: principal.userId,
        created_by_user_id: principal.userId,
        is_demo: isDemo,
        ...toPatientColumns(input),
      });
      await audit.record(
        {
          category: 'data_access',
          action: 'patient.profile_create',
          outcome: 'success',
          resourceType: 'patient',
          resourceId: id,
          patientId: id,
          metadata: { fields: Object.keys(input) },
        },
        { req, trx },
      );
      return toPatientView(await patients.findById(trx, id));
    });
  }

  async function getOwnProfile(principal, req) {
    return withActor(knex, principal.userId, async (trx) => {
      const row = await patients.findByUserId(trx, principal.userId);
      if (!row) throw new NotFoundError('You have not created a patient profile yet.');
      await accessPolicy.enforce({
        principal,
        permission: PERMISSIONS.PATIENTS_READ,
        resource: patientResource(row.id),
        req,
        trx,
      });
      return toPatientView(row);
    });
  }

  async function getProfile(principal, patientId, req) {
    if (!isUuid(patientId)) throw new NotFoundError();
    return withActor(knex, principal.userId, async (trx) => {
      const decision = await accessPolicy.enforce({
        principal,
        permission: PERMISSIONS.PATIENTS_READ,
        resource: patientResource(patientId),
        req,
        trx,
      });
      const row = rowOrMismatch(await patients.findById(trx, patientId), patientId, principal);
      return { ...toPatientView(row), access: { relationship: decision.relationship } };
    });
  }

  async function updateProfile(principal, patientId, patch, req) {
    if (!isUuid(patientId)) throw new NotFoundError();
    return withActor(knex, principal.userId, async (trx) => {
      await accessPolicy.enforce({
        principal,
        permission: PERMISSIONS.PATIENTS_WRITE,
        resource: patientResource(patientId),
        req,
        trx,
      });
      const current = rowOrMismatch(await patients.findById(trx, patientId), patientId, principal);
      validateMerged(current, patch);
      const updated = await patients.update(trx, patientId, toPatientColumns(patch));
      if (!updated) rowOrMismatch(null, patientId, principal);
      await audit.record(
        {
          category: 'data_access',
          action: 'patient.profile_update',
          outcome: 'success',
          resourceType: 'patient',
          resourceId: patientId,
          patientId,
          // Field names only: never values.
          metadata: { fields: Object.keys(patch) },
        },
        { req, trx },
      );
      return toPatientView(await patients.findById(trx, patientId));
    });
  }

  async function updateOwnProfile(principal, patch, req) {
    const own = await withActor(knex, principal.userId, (trx) =>
      patients.findByUserId(trx, principal.userId),
    );
    if (!own) throw new NotFoundError('You have not created a patient profile yet.');
    return updateProfile(principal, own.id, patch, req);
  }

  // ── Dependents ────────────────────────────────────────────────────

  /**
   * Creates a dependent profile (someone without their own login, e.g. a child or an
   * elderly parent) managed by the acting user. The family relationship is recorded
   * explicitly; access comes from the guardianship (basis `created_dependent`, scope
   * `manage`), not from being "family".
   */
  async function createDependent(
    principal,
    { relationshipType, ...profile },
    req,
    { isDemo = false } = {},
  ) {
    return withActor(knex, principal.userId, async (trx) => {
      if ((await patients.countActiveDependents(trx, principal.userId)) >= MAX_DEPENDENTS) {
        throw new ConflictError(
          `You can manage at most ${MAX_DEPENDENTS} dependents.`,
          'dependent_limit',
        );
      }
      const patientId = newId();
      const guardianshipId = newId();
      await patients.insert(trx, {
        id: patientId,
        user_id: null,
        created_by_user_id: principal.userId,
        is_demo: isDemo,
        ...toPatientColumns(profile),
      });
      await patients.insertGuardianship(trx, {
        id: guardianshipId,
        patient_id: patientId,
        guardian_user_id: principal.userId,
        relationship_type: relationshipType,
        access_scope: 'manage',
        basis: 'created_dependent',
        status: 'active',
        started_at: new Date(),
        created_by_user_id: principal.userId,
      });
      await audit.record(
        {
          category: 'data_access',
          action: 'patient.dependent_create',
          outcome: 'success',
          resourceType: 'guardianship',
          resourceId: guardianshipId,
          patientId,
          metadata: { relationshipType, accessScope: 'manage', basis: 'created_dependent' },
        },
        { req, trx },
      );
      const row = await patients.findById(trx, patientId);
      return {
        ...toPatientView(row),
        guardianship: { id: guardianshipId, relationshipType, accessScope: 'manage' },
      };
    });
  }

  async function listDependents(principal) {
    return withActor(knex, principal.userId, async (trx) => {
      const rows = await patients.dependentsOf(trx, principal.userId);
      return rows.map((row) => ({
        ...toPatientView(row),
        guardianship: {
          id: row.guardianship_id,
          relationshipType: row.relationship_type,
          accessScope: row.access_scope,
          startedAt: row.started_at,
        },
      }));
    });
  }

  async function listGuardians(principal, patientId, req) {
    if (!isUuid(patientId)) throw new NotFoundError();
    return withActor(knex, principal.userId, async (trx) => {
      await accessPolicy.enforce({
        principal,
        permission: PERMISSIONS.PATIENTS_READ,
        resource: patientResource(patientId),
        req,
        trx,
      });
      return (await patients.activeGuardianshipsFor(trx, patientId)).map(toGuardianshipView);
    });
  }

  /**
   * Ends a guardianship (by the guardian, or by a patient who has their own account).
   * A dependent without their own account is never left unmanaged: ending the last
   * managing guardianship archives the dependent profile in the same transaction.
   */
  async function endGuardianship(principal, guardianshipId, req) {
    if (!isUuid(guardianshipId)) throw new NotFoundError();
    return withActor(knex, principal.userId, async (trx) => {
      const g = await patients.findGuardianship(trx, guardianshipId);
      const decision = await accessPolicy.enforce({
        principal,
        permission: PERMISSIONS.DEPENDENTS_MANAGE,
        resource: {
          type: 'guardianship',
          id: guardianshipId,
          guardianUserId: g?.guardian_user_id,
          patientUserId: g?.patient_user_id,
        },
        req,
        trx,
      });
      if (g.status !== 'active')
        throw new ConflictError('This guardianship has already ended.', 'already_ended');

      const remaining = (await patients.activeGuardianshipsFor(trx, g.patient_id)).filter(
        (other) => other.id !== g.id && other.access_scope === 'manage',
      );
      const archiveDependent = !g.patient_user_id && remaining.length === 0;
      if (archiveDependent) {
        // Archive while this guardian still has manage rights (RLS requires them).
        await patients.update(trx, g.patient_id, { status: 'archived' });
      }
      await patients.updateGuardianship(trx, g.id, {
        status: 'ended',
        ended_at: new Date(),
        end_reason: decision.relationship === 'guardian' ? 'guardian_ended' : 'patient_ended',
      });
      await audit.record(
        {
          category: 'data_access',
          action: 'patient.guardianship_end',
          outcome: 'success',
          resourceType: 'guardianship',
          resourceId: g.id,
          patientId: g.patient_id,
          metadata: { endedBy: decision.relationship, dependentArchived: archiveDependent },
        },
        { req, trx },
      );
      return { id: g.id, status: 'ended', dependentArchived: archiveDependent };
    });
  }

  return {
    createOwnProfile,
    getOwnProfile,
    getProfile,
    updateProfile,
    updateOwnProfile,
    createDependent,
    listDependents,
    listGuardians,
    endGuardianship,
  };
}
