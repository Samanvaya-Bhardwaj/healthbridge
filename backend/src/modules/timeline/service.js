import { PERMISSIONS } from '@healthbridge/shared';
import { isUuid } from '../../core/db/ids.js';
import { withActor } from '../../core/db/actorContext.js';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../core/http/errors.js';

const SELF = new Set(['patient_self', 'guardian_dependent']);
const TYPES = ['appointment', 'document', 'lab_result'];

/** Plain-language provenance labels (shown with every event). */
export const PROVENANCE_LABELS = Object.freeze({
  patient_reported: 'Added by the patient',
  guardian_reported: 'Added by a guardian',
  doctor_reported: 'Added by a doctor',
  doctor_verified: 'Verified by a doctor',
  ai_extracted: 'Read by AI — not verified',
  system_recorded: 'Recorded by HealthBridge',
});

export function toEventView(row) {
  return {
    id: row.id,
    type: row.event_type,
    occurredAt: row.occurred_at,
    datePrecision: row.date_precision,
    title: row.title,
    status: row.status,
    provenance: row.provenance,
    provenanceLabel: PROVENANCE_LABELS[row.provenance],
    actor: row.actor_label,
    detail: row.detail,
    source: { type: row.source_type, id: row.source_id },
  };
}

const encode = (row) =>
  Buffer.from(JSON.stringify({ t: new Date(row.occurred_at).toISOString(), id: row.id })).toString(
    'base64url',
  );
function decode(cursor) {
  if (!cursor) return null;
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!isUuid(v.id) || Number.isNaN(Date.parse(v.t))) throw new Error('bad');
    return v;
  } catch {
    throw new BadRequestError('Invalid cursor.', 'invalid_cursor');
  }
}

/**
 * Timeline reads (ADR-0023). The timeline is part of the medical record: patient side,
 * or a treating doctor with consent (gate 3); RLS then shows each reader only the events
 * their consent (document type) or appointment covers.
 */
export function createTimelineService({ knex, accessPolicy, audit }) {
  async function authorize(trx, principal, patientId, permission, req) {
    if (!isUuid(patientId)) throw new NotFoundError();
    return accessPolicy.enforce({
      principal,
      permission,
      resource: { type: 'patient', id: patientId, patientId },
      req,
      trx,
    });
  }

  async function list(principal, patientId, { cursor, limit = 50, types }, req) {
    return withActor(knex, principal.userId, async (trx) => {
      const decision = await authorize(
        trx,
        principal,
        patientId,
        PERMISSIONS.MEDICAL_RECORDS_READ,
        req,
      );
      const after = decode(cursor);
      const q = trx('medical_events')
        .where({ patient_id: patientId, hidden: false })
        .orderBy([
          { column: 'occurred_at', order: 'desc' },
          { column: 'id', order: 'desc' },
        ])
        .limit(limit + 1);
      if (types?.length)
        q.whereIn(
          'event_type',
          types.filter((t) => TYPES.includes(t)),
        );
      if (after) q.whereRaw('(occurred_at, id) < (?::timestamptz, ?::uuid)', [after.t, after.id]);
      const rows = await q;
      const page = rows.slice(0, limit);
      if (!SELF.has(decision.relationship)) {
        await audit.record(
          {
            category: 'data_access',
            action: 'timeline.viewed',
            outcome: 'success',
            resourceType: 'patient',
            resourceId: patientId,
            patientId,
            reason: decision.relationship,
            metadata: { count: page.length, consentId: decision.consentId ?? null },
          },
          { req, trx },
        );
      }
      return {
        items: page.map(toEventView),
        nextCursor: rows.length > limit ? encode(page.at(-1)) : null,
      };
    });
  }

  /** Full JSON export for the patient side (portability), with provenance. */
  async function exportTimeline(principal, patientId, req) {
    return withActor(knex, principal.userId, async (trx) => {
      const decision = await authorize(trx, principal, patientId, PERMISSIONS.RECORDS_EXPORT, req);
      if (!SELF.has(decision.relationship)) throw new ForbiddenError();
      const rows = await trx('medical_events')
        .where({ patient_id: patientId, hidden: false })
        .orderBy([
          { column: 'occurred_at', order: 'asc' },
          { column: 'id', order: 'asc' },
        ])
        .limit(10_000);
      await audit.record(
        {
          category: 'data_access',
          action: 'timeline.exported',
          outcome: 'success',
          resourceType: 'patient',
          resourceId: patientId,
          patientId,
          reason: decision.relationship,
          metadata: { count: rows.length },
        },
        { req, trx },
      );
      return {
        format: 'healthbridge.timeline.v1',
        generatedAt: new Date().toISOString(),
        patientId,
        provenanceLegend: PROVENANCE_LABELS,
        note: 'Synthetic demo data. Lab values are included only once verified by a doctor.',
        events: rows.map(toEventView),
      };
    });
  }

  return { list, exportTimeline };
}
