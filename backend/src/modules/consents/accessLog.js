import { PERMISSIONS } from '@healthbridge/shared';
import { isUuid } from '../../core/db/ids.js';
import { withActor } from '../../core/db/actorContext.js';
import { BadRequestError, NotFoundError } from '../../core/http/errors.js';

/**
 * Patient-facing access log (ADR-0021), built on the existing append-only audit trail —
 * not a second audit system. Structured audit rows become plain-language entries.
 * Never exposed: IP addresses, user agents, request/session ids, raw metadata, database
 * ids, and the identity of accounts with no relationship to the patient.
 */

const ACTIONS = [
  'consent.granted',
  'consent.revoked',
  'consent.expired',
  'document.upload_completed',
  'document.promoted',
  'document.scan_rejected',
  'document.viewed',
  'document.list_viewed',
  'document.download_authorized',
  'document.access_denied',
  'document.retired',
  'document.ai_extracted',
  'document.extraction_viewed',
  'lab_result.verified',
  'timeline.viewed',
  'timeline.exported',
  'patient.ai_processing_changed',
  'record.question_answered',
  'brief.generated',
  'brief.viewed',
  'consultation.started',
  'consultation.viewed',
  'consultation.outcome_recorded',
  'consultation.emergency_escalated',
  'clinical_note.signed',
  'clinical_note.corrected',
  'prescription.signed',
  'prescription.corrected',
  'prescription.list_viewed',
  'prescription.downloaded',
  'patients:read',
];
const SELF_REASONS = new Set(['patient_self', 'guardian_dependent']);

const DESCRIBE = {
  'consent.granted': (a, e) => `${a} gave ${e.doctor ?? 'a doctor'} access to records`,
  'consent.revoked': (a, e) => `${a} revoked access for ${e.doctor ?? 'a doctor'}`,
  'consent.expired': (_a, e) => `Access for ${e.doctor ?? 'a doctor'} expired`,
  'document.upload_completed': (a, e) => `${a} uploaded ${e.document}`,
  'document.promoted': (_a, e) => `${e.document} passed the safety check and is available`,
  'document.scan_rejected': (_a, e) => `${e.document} was not accepted (${e.reason})`,
  'document.viewed': (a, e) => `${a} viewed ${e.document}`,
  'document.list_viewed': (a) => `${a} viewed the list of documents`,
  'document.download_authorized': (a, e) => `${a} downloaded ${e.document}`,
  'document.access_denied': (a, e) => `${a} was denied access to ${e.document}`,
  'document.retired': (a, e) => `${a} removed ${e.document}`,
  'document.ai_extracted': (_a, e) => `AI read ${e.document} and suggested values for review`,
  'document.extraction_viewed': (a, e) => `${a} viewed the values suggested from ${e.document}`,
  'lab_result.verified': (a, e) => `${a} verified lab values from ${e.document}`,
  'timeline.viewed': (a) => `${a} viewed the health timeline`,
  'timeline.exported': (a) => `${a} exported the health timeline`,
  'patient.ai_processing_changed': (a, e) =>
    `${a} turned AI document reading ${e.reason === 'enabled' ? 'on' : 'off'}`,
  'record.question_answered': (a) => `${a} asked HealthBridge AI a question about the records`,
  'brief.generated': (a) => `${a} prepared an AI brief before an appointment`,
  'brief.viewed': (a) => `${a} viewed the AI brief for an appointment`,
  'consultation.started': (a) => `${a} started a consultation`,
  'consultation.viewed': (a) => `${a} viewed consultation notes and prescriptions`,
  'consultation.outcome_recorded': (a) => `${a} recorded the outcome of a consultation`,
  'consultation.emergency_escalated': (a) => `${a} advised emergency care during a consultation`,
  'clinical_note.signed': (a) => `${a} signed a consultation note`,
  'clinical_note.corrected': (a) => `${a} corrected a consultation note`,
  'prescription.signed': (a) => `${a} signed a prescription`,
  'prescription.corrected': (a) => `${a} corrected a prescription`,
  'prescription.list_viewed': (a) => `${a} viewed the list of prescriptions`,
  'prescription.downloaded': (a) => `${a} downloaded a prescription`,
  'patients:read': (a) => `${a} viewed the profile`,
};
const REJECTION_LABELS = {
  infected: 'failed the safety scan',
  upload_expired: 'upload not finished',
  size_exceeded: 'file too large',
  type_mismatch: 'file type did not match',
  unsupported_content: 'unsupported file',
};

const encodeCursor = (row) =>
  Buffer.from(JSON.stringify({ t: row.occurred_at.toISOString(), id: row.id })).toString(
    'base64url',
  );
function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof value.t !== 'string' || !isUuid(value.id)) throw new Error('bad cursor');
    return value;
  } catch {
    throw new BadRequestError('Invalid cursor.', 'invalid_cursor');
  }
}

export function createAccessLogService({ knex, accessPolicy }) {
  async function list(principal, patientId, { cursor, limit = 30 }, req) {
    if (!isUuid(patientId)) throw new NotFoundError();
    return withActor(knex, principal.userId, async (trx) => {
      await accessPolicy.enforce({
        principal,
        permission: PERMISSIONS.ACCESS_LOG_READ,
        resource: { type: 'consent', relPatientId: patientId },
        req,
        trx,
      });
      const after = decodeCursor(cursor);
      const query = trx('audit.audit_logs')
        .select(
          'id',
          'occurred_at',
          'action',
          'outcome',
          'actor_type',
          'actor_user_id',
          'resource_type',
          'resource_id',
          'reason',
          'metadata',
        )
        .where({ patient_id: patientId })
        .whereIn('action', ACTIONS)
        // Own profile reads by the patient side are noise; doctors' reads are not.
        .whereNot((w) => w.where('action', 'patients:read').whereIn('reason', [...SELF_REASONS]))
        .whereNot((w) => w.where('action', 'patients:read').whereNot('outcome', 'success'))
        .orderBy([
          { column: 'occurred_at', order: 'desc' },
          { column: 'id', order: 'desc' },
        ])
        .limit(limit + 1);
      if (after)
        query.whereRaw('(occurred_at, id) < (?::timestamptz, ?::uuid)', [after.t, after.id]);
      const rows = await query;
      const page = rows.slice(0, limit);

      // Names: actors, doctors named in consent events, document titles (patient-side RLS).
      const userIds = [...new Set(page.map((r) => r.actor_user_id).filter(Boolean))];
      const doctorIds = [...new Set(page.map((r) => r.metadata?.doctorId).filter(isUuid))];
      const documentIds = [
        ...new Set(
          page
            .filter((r) => r.resource_type === 'medical_document')
            .map((r) => r.resource_id)
            .filter(isUuid),
        ),
      ];
      // Account and professional names are not patient-scoped (pool connection).
      const [users, doctorsByUser, doctorsById] = await Promise.all([
        userIds.length ? knex('users').whereIn('id', userIds).select('id', 'full_name') : [],
        userIds.length
          ? knex('doctors').whereIn('user_id', userIds).select('user_id', 'professional_name')
          : [],
        doctorIds.length
          ? knex('doctors').whereIn('id', doctorIds).select('id', 'professional_name')
          : [],
      ]);
      // Patient-scoped reads stay in the actor transaction, one after another.
      const titles = documentIds.length
        ? await trx('medical_documents').whereIn('id', documentIds).select('id', 'title')
        : [];
      const self = await trx('patients').where({ id: patientId }).first('user_id');
      const guardianIds = new Set(
        (
          await trx('patient_guardianships')
            .where({ patient_id: patientId })
            .select('guardian_user_id')
        ).map((g) => g.guardian_user_id),
      );
      const userName = new Map(users.map((u) => [u.id, u.full_name]));
      const doctorByUser = new Map(doctorsByUser.map((d) => [d.user_id, d.professional_name]));
      const doctorById = new Map(doctorsById.map((d) => [d.id, d.professional_name]));
      const title = new Map(titles.map((d) => [d.id, d.title]));

      // A doctor's access is reported by name only when they have (had) a role in this
      // record; anyone else is anonymous.
      const relatedDoctors = new Set(
        (
          await trx('care_relationships as cr')
            .join('doctors as d', 'd.id', 'cr.doctor_id')
            .where('cr.patient_id', patientId)
            .select('d.user_id')
        ).map((r) => r.user_id),
      );

      const actorOf = (row) => {
        if (row.actor_type === 'system') return { kind: 'system', name: 'HealthBridge' };
        const id = row.actor_user_id;
        if (!id) return { kind: 'unknown', name: 'Someone' };
        if (id === principal.userId) return { kind: 'you', name: 'You' };
        if (self?.user_id === id)
          return { kind: 'patient', name: userName.get(id) ?? 'The patient' };
        if (guardianIds.has(id))
          return { kind: 'guardian', name: `${userName.get(id) ?? 'A guardian'} (guardian)` };
        if (doctorByUser.has(id) && relatedDoctors.has(id)) {
          return { kind: 'doctor', name: doctorByUser.get(id) };
        }
        return { kind: 'unknown', name: 'An account with no access to this record' };
      };

      return {
        items: page.map((row) => {
          const actor = actorOf(row);
          const extra = {
            doctor: doctorById.get(row.metadata?.doctorId),
            document:
              row.resource_type === 'medical_document'
                ? `“${title.get(row.resource_id) ?? 'a document'}”`
                : 'the records',
            reason:
              row.action === 'patient.ai_processing_changed'
                ? row.reason
                : (REJECTION_LABELS[row.reason] ?? 'not accepted'),
          };
          return {
            occurredAt: row.occurred_at,
            actor,
            action: row.action,
            outcome: row.outcome,
            description: DESCRIBE[row.action](actor.name, extra),
          };
        }),
        nextCursor: rows.length > limit ? encodeCursor(page.at(-1)) : null,
      };
    });
  }

  return { list };
}
