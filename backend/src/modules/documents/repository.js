import { assertScopedTransaction } from '../../core/db/actorContext.js';

/** Metadata view: never storage keys, URLs or content. */
export function toDocumentView(row) {
  return {
    id: row.id,
    patientId: row.patient_id,
    documentType: row.document_type,
    title: row.title,
    originalFilename: row.original_filename,
    contentType: row.detected_content_type ?? row.declared_content_type,
    sizeBytes: Number(row.object_size_bytes ?? row.declared_size_bytes),
    status: row.status,
    rejectionReason: row.rejection_reason,
    uploadedBy: {
      relationship: row.uploaded_by_relationship,
      name: row.uploader_doctor_name ?? row.uploader_name ?? null,
    },
    createdAt: row.created_at,
    uploadedAt: row.uploaded_at,
    availableAt: row.available_at,
    retiredAt: row.retired_at,
  };
}

/**
 * medical_documents: users read through RLS (patient side; consented doctors see
 * AVAILABLE documents of permitted types) and may only INSERT upload intents; every
 * status change runs in a `documents` system transaction.
 */
export function createDocumentRepository() {
  const withUploader = (trx) =>
    trx('medical_documents as m')
      .join('users as u', 'u.id', 'm.uploaded_by_user_id')
      .leftJoin('doctors as d', 'd.user_id', 'm.uploaded_by_user_id')
      .select(
        'm.*',
        'u.full_name as uploader_name',
        trx.raw(
          "CASE WHEN m.uploaded_by_relationship = 'treating_doctor' THEN d.professional_name END AS uploader_doctor_name",
        ),
      );

  return {
    /** Classification fields for authorisation (SECURITY DEFINER function). */
    async ref(trx, id) {
      assertScopedTransaction(trx);
      const { rows } = await trx.raw('SELECT * FROM authz.document_ref(?)', [id]);
      return rows[0] ?? null;
    },
    findById(trx, id, { forUpdate = false } = {}) {
      assertScopedTransaction(trx);
      if (forUpdate) return trx('medical_documents').where({ id }).forUpdate().first();
      return withUploader(trx).where('m.id', id).first();
    },
    forPatient(trx, patientId, { includeRetired = false } = {}) {
      assertScopedTransaction(trx);
      const q = withUploader(trx)
        .where('m.patient_id', patientId)
        .orderBy('m.created_at', 'desc')
        .limit(200);
      if (!includeRetired) q.whereNot('m.status', 'retired');
      return q;
    },
    async insert(trx, row) {
      assertScopedTransaction(trx);
      await trx('medical_documents').insert(row);
    },
    async update(trx, id, patch, { whereStatus } = {}) {
      assertScopedTransaction(trx, 'documents');
      const q = trx('medical_documents').where({ id });
      if (whereStatus) q.whereIn('status', [].concat(whereStatus));
      return q.update(patch);
    },
    /** Upload intents whose upload window passed without completion. */
    staleIntents(trx, limit) {
      assertScopedTransaction(trx, 'documents');
      return trx('medical_documents')
        .where({ status: 'pending_upload' })
        .where('upload_expires_at', '<=', trx.fn.now())
        .limit(limit)
        .forUpdate()
        .skipLocked();
    },
  };
}
