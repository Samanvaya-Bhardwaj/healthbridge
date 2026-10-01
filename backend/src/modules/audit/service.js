import { isIP } from 'node:net';
import { newId } from '../../core/db/ids.js';
import { sanitizeMetadata } from './sanitize.js';

const AUDIT_TABLE = 'audit.audit_logs';
const MAX_USER_AGENT = 512;

/**
 * @typedef {object} AuditEvent
 * @property {'authentication'|'authorization'|'account'|'administration'|'data_access'|'system'} category
 * @property {string} action          e.g. "auth.login", "admin.user.role_grant", "users:read"
 * @property {'success'|'failure'|'denied'} outcome
 * @property {import('../../core/authz/principal.js').Principal | { userId: string, roles?: string[], sessionId?: string } | 'system' | null} [actor]
 * @property {string|null} [resourceType]
 * @property {string|null} [resourceId]
 * @property {string|null} [patientId]
 * @property {string|null} [reason]    machine-readable reason code, never free text with PII
 * @property {Record<string, unknown>} [metadata]
 */

function actorFields(actor, req) {
  const effective = actor === undefined ? req?.principal : actor;
  if (effective === 'system') return { actor_type: 'system', actor_user_id: null, actor_roles: [] };
  if (!effective?.userId) return { actor_type: 'anonymous', actor_user_id: null, actor_roles: [] };
  return {
    actor_type: 'user',
    actor_user_id: effective.userId,
    actor_roles: [...(effective.roles ?? [])],
    session_id: effective.sessionId ?? null,
  };
}

function requestFields(req) {
  if (!req) return {};
  const ip = req.ip?.replace(/^::ffff:/, '');
  return {
    request_id: req.id ?? null,
    ip: ip && isIP(ip) ? ip : null,
    user_agent: req.get?.('user-agent')?.slice(0, MAX_USER_AGENT) ?? null,
  };
}

/**
 * Append-only audit trail writer (ADR-0006, ADR-0016).
 * The application role holds only SELECT/INSERT on the table and a trigger rejects
 * UPDATE/DELETE/TRUNCATE, so audit rows cannot be altered from the application.
 *
 * @param {{ knex: import('knex').Knex, logger: import('pino').Logger }} deps
 */
export function createAuditService({ knex, logger }) {
  function toRow(event, req) {
    return {
      id: newId(),
      category: event.category,
      action: event.action,
      outcome: event.outcome,
      resource_type: event.resourceType ?? null,
      resource_id: event.resourceId ?? null,
      patient_id: event.patientId ?? null,
      reason: event.reason ?? null,
      metadata: sanitizeMetadata(event.metadata ?? {}),
      session_id: null,
      ...actorFields(event.actor, req),
      ...requestFields(req),
    };
  }

  /**
   * Writes an audit row. Inside a transaction (`trx`) the row commits or rolls back with
   * the business change, so a successful sensitive action is never left unaudited.
   * Throws on failure (fail closed).
   * @param {AuditEvent} event
   * @param {{ req?: import('express').Request, trx?: import('knex').Knex.Transaction }} [context]
   */
  async function record(event, { req, trx } = {}) {
    await (trx ?? knex)(AUDIT_TABLE).insert(toRow(event, req));
  }

  /**
   * For events that must not change the outcome (e.g. a denial is denied regardless).
   * Failures are logged (without metadata) and swallowed.
   * @param {AuditEvent} event
   */
  async function recordBestEffort(event, context = {}) {
    try {
      await record(event, context);
    } catch (err) {
      logger.error(
        {
          err: { name: err.name, code: err.code },
          action: event.action,
          requestId: context.req?.id,
        },
        'audit write failed',
      );
    }
  }

  return { record, recordBestEffort };
}
