import { ForbiddenError, NotFoundError, UnauthorizedError } from '../http/errors.js';
import { hasPermission } from './principal.js';

/**
 * Central authorisation service: the three-gate model (ADR-0006, ADR-0017).
 *
 *   Gate 1  Role permission       principal holds the permission, globally or for the
 *                                 clinic in scope (clinic-scoped roles)          → else 403
 *   Gate 2  Resource relationship a registered resolver relates the principal to this
 *                                 specific resource                              → else 404
 *   Gate 3  Active consent        for patient data, the consent resolver finds a basis
 *                                 for access unless the relationship is the patient
 *                                 themself or an authorised guardian             → else 403
 *
 * Fail-closed: an unknown resource type, a missing resolver, or a resolver/consent error
 * denies. Every denial is audited; every decision about patient data (allow or deny) is
 * audited with the relationship and consent basis that applied.
 *
 * Resolvers receive `{ permission, trx }`; callers already inside an actor (RLS)
 * transaction pass `trx` so resolution sees the same snapshot and RLS context.
 */

/**
 * @typedef {{ type: string, id?: string, patientId?: string, clinicId?: string, [key: string]: unknown }} Resource
 * @typedef {{ related: boolean, relationship?: string, reason?: string }} RelationshipResult
 * @typedef {(principal: import('./principal.js').Principal, resource: Resource, ctx: { permission: string, trx?: import('knex').Knex.Transaction }) => Promise<RelationshipResult> | RelationshipResult} RelationshipResolver
 * @typedef {{ consentId?: string | null, basis: string }} ConsentGrant
 * @typedef {(args: { principal: import('./principal.js').Principal, patientId: string, permission: string, relationship: string, purpose?: string, trx?: import('knex').Knex.Transaction }) => Promise<ConsentGrant | null>} ConsentResolver
 * @typedef {{ allowed: boolean, gate?: 'permission' | 'relationship' | 'consent', reason?: string, relationship?: string, consentBasis?: string, consentId?: string | null }} Decision
 * @typedef {{ principal: import('./principal.js').Principal, permission: string, resource?: Resource, clinicId?: string, purpose?: string, req?: import('express').Request, trx?: import('knex').Knex.Transaction }} AccessRequest
 */

/** Relationships that own the patient data themselves and therefore need no consent. */
export const SELF_RELATIONSHIPS = new Set(['patient_self', 'guardian_dependent']);

/** Default consent resolver when none is configured: no consent → deny. */
const denyAllConsent = async () => null;

/**
 * @param {{
 *   audit: ReturnType<typeof import('../../modules/audit/service.js').createAuditService>,
 *   relationshipResolvers?: Record<string, RelationshipResolver>,
 *   consentResolver?: ConsentResolver,
 *   logger?: import('pino').Logger,
 * }} deps
 */
export function createAccessPolicy({
  audit,
  relationshipResolvers = {},
  consentResolver = denyAllConsent,
  logger,
}) {
  const resolvers = new Map(Object.entries(relationshipResolvers));

  /**
   * @param {AccessRequest} request
   * @returns {Promise<Decision>}
   */
  async function evaluate({ principal, permission, resource, clinicId, purpose, trx }) {
    if (!hasPermission(principal, permission, resource?.clinicId ?? clinicId)) {
      return { allowed: false, gate: 'permission', reason: 'missing_permission' };
    }
    if (!resource) return { allowed: true };

    const resolver = resolvers.get(resource.type);
    if (!resolver) {
      return { allowed: false, gate: 'relationship', reason: 'no_relationship_resolver' };
    }

    let relation;
    try {
      relation = await resolver(principal, resource, { permission, trx });
    } catch (err) {
      logger?.error({ err, resourceType: resource.type }, 'relationship resolver failed');
      return { allowed: false, gate: 'relationship', reason: 'resolver_error' };
    }
    if (!relation?.related) {
      return { allowed: false, gate: 'relationship', reason: relation?.reason ?? 'not_related' };
    }

    if (resource.patientId && !SELF_RELATIONSHIPS.has(relation.relationship)) {
      let consent;
      try {
        consent = await consentResolver({
          principal,
          patientId: resource.patientId,
          permission,
          relationship: relation.relationship,
          purpose,
          trx,
        });
      } catch (err) {
        logger?.error({ err }, 'consent resolver failed');
        consent = null;
      }
      if (!consent) {
        return {
          allowed: false,
          gate: 'consent',
          reason: 'no_active_consent',
          relationship: relation.relationship,
        };
      }
      return {
        allowed: true,
        relationship: relation.relationship,
        consentBasis: consent.basis,
        consentId: consent.consentId ?? null,
      };
    }
    return { allowed: true, relationship: relation.relationship };
  }

  function auditEvent(decision, { principal, permission, resource, clinicId, purpose, req }) {
    const endpoint = req?.route?.path ? `${req.method} ${req.baseUrl}${req.route.path}` : undefined;
    const scopeClinic = resource?.clinicId ?? clinicId;
    return {
      category: resource?.patientId ? 'data_access' : 'authorization',
      action: permission,
      outcome: decision.allowed ? 'success' : 'denied',
      reason: decision.allowed ? decision.relationship : `${decision.gate}:${decision.reason}`,
      actor: principal,
      resourceType: resource?.type ?? null,
      resourceId: resource?.id ?? null,
      patientId: resource?.patientId ?? null,
      metadata: {
        ...(endpoint ? { endpoint } : {}),
        ...(purpose ? { purpose } : {}),
        ...(scopeClinic ? { clinicId: scopeClinic } : {}),
        ...(!decision.allowed && decision.relationship
          ? { relationship: decision.relationship }
          : {}),
        ...(decision.consentBasis ? { consentBasis: decision.consentBasis } : {}),
        ...(decision.consentId ? { consentId: decision.consentId } : {}),
      },
    };
  }

  /**
   * Evaluates and throws on denial. Services call this before touching a resource.
   * @param {AccessRequest} request
   */
  async function enforce(request) {
    if (!request.principal) throw new UnauthorizedError();
    const decision = await evaluate(request);
    const shouldAudit = !decision.allowed || Boolean(request.resource?.patientId);
    if (shouldAudit) {
      const event = auditEvent(decision, request);
      // Allowed patient-data access is audited in the caller's transaction (fail closed);
      // a denial is enforced even if the audit write fails.
      if (decision.allowed) await audit.record(event, { req: request.req, trx: request.trx });
      else await audit.recordBestEffort(event, { req: request.req });
    }
    if (decision.allowed) return decision;
    if (decision.gate === 'relationship') throw new NotFoundError();
    if (decision.gate === 'consent') {
      throw new ForbiddenError(
        'Patient consent is required to access this record.',
        'consent_required',
      );
    }
    throw new ForbiddenError();
  }

  /**
   * Express middleware for gate 1 on a whole route. For clinic-scoped routes, pass the
   * route parameter holding the clinic id so clinic-scoped grants are honoured.
   * @param {string} permission
   * @param {{ clinicParam?: string }} [options]
   */
  function requirePermission(permission, { clinicParam } = {}) {
    return async (req, _res, next) => {
      try {
        await enforce({
          principal: req.principal,
          permission,
          clinicId: clinicParam ? req.params[clinicParam] : undefined,
          req,
        });
        next();
      } catch (err) {
        next(err);
      }
    };
  }

  return { evaluate, enforce, requirePermission };
}
