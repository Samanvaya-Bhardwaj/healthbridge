import { ForbiddenError, NotFoundError, UnauthorizedError } from '../http/errors.js';

/**
 * Central authorisation service: the three-gate model (ADR-0006).
 *
 *   Gate 1  Role permission      principal holds the permission         → else 403
 *   Gate 2  Resource relationship a registered resolver relates the
 *                                principal to this specific resource     → else 404
 *   Gate 3  Active consent       for patient data, a consent resolver
 *                                finds an active consent (unless the
 *                                relationship is the patient/guardian)   → else 403 consent_required
 *
 * Fail-closed: an unknown resource type, a missing resolver or a resolver error denies.
 * Every denial is audited; every decision about patient data (allow or deny) is audited.
 *
 * M1 registers the `session` and `user_account` resolvers. Patient, guardian and
 * treating-doctor relationships (M2) and the consent resolver (M5) plug in here
 * without changing callers.
 */

/**
 * @typedef {{ type: string, id?: string, patientId?: string, [key: string]: unknown }} Resource
 * @typedef {{ related: boolean, relationship?: string }} RelationshipResult
 * @typedef {(principal: import('./principal.js').Principal, resource: Resource) => Promise<RelationshipResult> | RelationshipResult} RelationshipResolver
 * @typedef {(args: { principal: import('./principal.js').Principal, patientId: string, permission: string, purpose?: string }) => Promise<{ consentId: string } | null>} ConsentResolver
 * @typedef {{ allowed: boolean, gate?: 'permission' | 'relationship' | 'consent', reason?: string, relationship?: string, consentId?: string }} Decision
 */

/** Relationships that own the patient data themselves and therefore need no consent. */
const SELF_RELATIONSHIPS = new Set(['self', 'guardian']);

/** Default consent resolver until the consent module exists: no consent → deny. */
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
   * @param {{ principal: import('./principal.js').Principal, permission: string, resource?: Resource, purpose?: string }} request
   * @returns {Promise<Decision>}
   */
  async function evaluate({ principal, permission, resource, purpose }) {
    if (!principal?.permissions?.has(permission)) {
      return { allowed: false, gate: 'permission', reason: 'missing_permission' };
    }
    if (!resource) return { allowed: true };

    const resolver = resolvers.get(resource.type);
    if (!resolver)
      return { allowed: false, gate: 'relationship', reason: 'no_relationship_resolver' };

    let relation;
    try {
      relation = await resolver(principal, resource);
    } catch (err) {
      logger?.error({ err, resourceType: resource.type }, 'relationship resolver failed');
      return { allowed: false, gate: 'relationship', reason: 'resolver_error' };
    }
    if (!relation?.related) return { allowed: false, gate: 'relationship', reason: 'not_related' };

    if (resource.patientId && !SELF_RELATIONSHIPS.has(relation.relationship)) {
      let consent;
      try {
        consent = await consentResolver({
          principal,
          patientId: resource.patientId,
          permission,
          purpose,
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
      return { allowed: true, relationship: relation.relationship, consentId: consent.consentId };
    }
    return { allowed: true, relationship: relation.relationship };
  }

  function auditEvent(decision, { principal, permission, resource, purpose, req }) {
    const endpoint = req?.route?.path ? `${req.method} ${req.baseUrl}${req.route.path}` : undefined;
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
        ...(decision.consentId ? { consentId: decision.consentId } : {}),
      },
    };
  }

  /**
   * Evaluates and throws on denial. Use from services before touching a resource.
   * @param {{ principal: import('./principal.js').Principal, permission: string, resource?: Resource, purpose?: string, req?: import('express').Request }} request
   */
  async function enforce(request) {
    if (!request.principal) throw new UnauthorizedError();
    const decision = await evaluate(request);
    const shouldAudit = !decision.allowed || Boolean(request.resource?.patientId);
    if (shouldAudit) {
      // Denials never depend on the audit write succeeding; allowed patient-data access does.
      const event = auditEvent(decision, request);
      if (decision.allowed) await audit.record(event, { req: request.req });
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

  /** Express middleware for gate 1 on a whole route (no specific resource). */
  function requirePermission(permission) {
    return async (req, _res, next) => {
      try {
        await enforce({
          principal: req.principal,
          permission,
          resource: undefined,
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
