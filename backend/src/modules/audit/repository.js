import { decodeCursor, encodeCursor } from '../../core/http/pagination.js';

const COLUMNS = [
  'id',
  'occurred_at',
  'category',
  'action',
  'outcome',
  'actor_type',
  'actor_user_id',
  'actor_roles',
  'session_id',
  'resource_type',
  'resource_id',
  'patient_id',
  'reason',
  'request_id',
  'ip',
  'user_agent',
  'metadata',
];

/** Read side of the audit log (administration). */
export function createAuditRepository({ knex }) {
  /**
   * Keyset pagination, newest first.
   * @param {{ actorUserId?: string, patientId?: string, resourceType?: string, action?: string, outcome?: string, category?: string, requestId?: string, from?: Date, to?: Date, cursor?: string, limit: number }} filter
   */
  async function list({
    actorUserId,
    patientId,
    resourceType,
    action,
    outcome,
    category,
    requestId,
    from,
    to,
    cursor,
    limit,
  }) {
    const query = knex('audit.audit_logs').select(COLUMNS);
    if (actorUserId) query.where('actor_user_id', actorUserId);
    if (patientId) query.where('patient_id', patientId);
    if (resourceType) query.where('resource_type', resourceType);
    if (action) query.where('action', action);
    if (outcome) query.where('outcome', outcome);
    if (category) query.where('category', category);
    if (requestId) query.where('request_id', requestId);
    if (from) query.where('occurred_at', '>=', from);
    if (to) query.where('occurred_at', '<', to);
    const after = decodeCursor(cursor);
    if (after) {
      query.whereRaw('(occurred_at, id) < (?::timestamptz, ?::uuid)', [after.t, after.id]);
    }
    const rows = await query
      .orderBy([
        { column: 'occurred_at', order: 'desc' },
        { column: 'id', order: 'desc' },
      ])
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(toView),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({ t: last.occurred_at.toISOString(), id: last.id })
          : null,
    };
  }

  return { list };
}

function toView(row) {
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    category: row.category,
    action: row.action,
    outcome: row.outcome,
    actor: { type: row.actor_type, userId: row.actor_user_id, roles: row.actor_roles },
    sessionId: row.session_id,
    resource: row.resource_type ? { type: row.resource_type, id: row.resource_id } : null,
    patientId: row.patient_id,
    reason: row.reason,
    requestId: row.request_id,
    ip: row.ip,
    userAgent: row.user_agent,
    metadata: row.metadata,
  };
}
