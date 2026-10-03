import { randomBytes } from 'node:crypto';
import { PERMISSIONS } from '@healthbridge/shared';
import { isUuid, newId } from '../../core/db/ids.js';
import { withActor, withSystem } from '../../core/db/actorContext.js';
import { appendOutboxEvent } from '../../core/events/outbox.js';
import { AppError, ConflictError, ForbiddenError, NotFoundError } from '../../core/http/errors.js';
import { domainMetrics } from '../../core/metrics/domain.js';
import { toDocumentView } from './repository.js';

const DATA = 'data_access';
const SELF = new Set(['patient_self', 'guardian_dependent']);
const UPLOADER = {
  patient_self: 'patient_self',
  guardian_dependent: 'guardian',
  treating_doctor: 'treating_doctor',
};

class FileTooLargeError extends AppError {
  constructor(maxBytes) {
    super({
      status: 413,
      code: 'file_too_large',
      title: 'File too large',
      detail: `Files can be at most ${Math.floor(maxBytes / (1024 * 1024))} MB.`,
    });
  }
}

/** Server-generated object keys: random, bound to patient and document, no user input. */
export function objectKeys(patientId, documentId) {
  const random = () => randomBytes(16).toString('hex');
  return {
    quarantineKey: `quarantine/patients/${patientId}/documents/${documentId}/${random()}`,
    storageKey: `records/patients/${patientId}/documents/${documentId}/${random()}`,
  };
}

/**
 * Medical documents for people (ADR-0021). Every call:
 *   1. resolves classification (authz.document_ref) and goes through AccessPolicy:
 *      permission + relationship (incl. resource state) + explicit consent, at request
 *      time;
 *   2. reads rows under RLS in the caller's actor transaction;
 *   3. audits the access (denials included, with a metric).
 * Status changes (completion, retirement) run as `documents` system transactions after
 * authorisation; scanning and promotion run in the worker (pipeline.js).
 */
export function createDocumentService({
  knex,
  config,
  documents,
  storage,
  accessPolicy,
  audit,
  logger,
  now = () => new Date(),
}) {
  const docResource = (id, ref) => ({
    type: 'medical_document',
    id,
    patientId: ref?.patient_id,
    documentType: ref?.document_type,
    status: ref?.status,
    uploadedByUserId: ref?.uploaded_by_user_id,
  });

  async function deny(err, { principal, documentId, patientId, action, req }) {
    if (!(err instanceof ForbiddenError || err instanceof NotFoundError)) return;
    domainMetrics.documentAccessDenied.inc();
    await audit.recordBestEffort(
      {
        category: DATA,
        action: 'document.access_denied',
        outcome: 'denied',
        actor: principal,
        // A patient-level request (list, upload) names the record, not a document.
        resourceType: documentId ? 'medical_document' : 'patient',
        resourceId: documentId ?? patientId ?? null,
        patientId: patientId ?? null,
        reason: err.code ?? 'denied',
        metadata: { attempted: action },
      },
      { req },
    );
  }

  /** Authorises access to one document; returns the decision and the RLS-visible row. */
  async function authorizeDocument(trx, principal, id, permission, req) {
    if (!isUuid(id)) throw new NotFoundError();
    const ref = await documents.ref(trx, id);
    try {
      const decision = await accessPolicy.enforce({
        principal,
        permission,
        resource: docResource(id, ref),
        req,
        trx,
      });
      const row = await documents.findById(trx, id);
      if (!row) throw new NotFoundError(); // RLS disagrees: fail closed
      return { decision, row };
    } catch (err) {
      await deny(err, {
        principal,
        documentId: id,
        patientId: ref?.patient_id,
        action: permission,
        req,
      });
      throw err;
    }
  }

  async function authorizePatient(trx, principal, patientId, permission, req, extra = {}) {
    if (!isUuid(patientId)) throw new NotFoundError();
    try {
      return await accessPolicy.enforce({
        principal,
        permission,
        resource: { type: 'patient', id: patientId, patientId, ...extra },
        req,
        trx,
      });
    } catch (err) {
      await deny(err, { principal, patientId, action: permission, req });
      throw err;
    }
  }

  // ── Upload ──────────────────────────────────────────────────────

  async function createUploadIntent(principal, patientId, input, req) {
    const maxBytes = config.documents.maxBytes;
    const created = await withActor(knex, principal.userId, async (trx) => {
      const decision = await authorizePatient(
        trx,
        principal,
        patientId,
        PERMISSIONS.MEDICAL_RECORDS_WRITE,
        req,
        { documentType: input.documentType },
      );
      if (input.sizeBytes > maxBytes) throw new FileTooLargeError(maxBytes);
      const id = newId();
      const keys = objectKeys(patientId, id);
      const row = {
        id,
        patient_id: patientId,
        uploaded_by_user_id: principal.userId,
        uploaded_by_relationship: UPLOADER[decision.relationship],
        uploader_consent_id:
          decision.relationship === 'treating_doctor' ? decision.consentId : null,
        document_type: input.documentType,
        title: input.title,
        original_filename: input.filename,
        declared_content_type: input.contentType,
        declared_size_bytes: input.sizeBytes,
        declared_sha256: input.sha256,
        quarantine_key: keys.quarantineKey,
        storage_key: keys.storageKey,
        upload_expires_at: new Date(
          now().getTime() + config.documents.uploadUrlTtlSeconds * 1000 + 60_000,
        ),
      };
      await documents.insert(trx, row);
      await audit.record(
        {
          category: DATA,
          action: 'document.upload_intent_created',
          outcome: 'success',
          resourceType: 'medical_document',
          resourceId: id,
          patientId,
          reason: row.uploaded_by_relationship,
          metadata: {
            documentType: input.documentType,
            contentType: input.contentType,
            sizeBytes: input.sizeBytes,
          },
        },
        { req, trx },
      );
      return { row: await documents.findById(trx, id), keys };
    });
    domainMetrics.documentUploadIntents.inc();
    const upload = await storage.createUploadIntent({
      key: created.keys.quarantineKey,
      contentType: input.contentType,
      maxBytes: Math.min(maxBytes, input.sizeBytes),
      ttlSeconds: config.documents.uploadUrlTtlSeconds,
    });
    return { document: toDocumentView(created.row), upload };
  }

  /**
   * The uploader reports the upload finished. The object must exist with the declared
   * size; then the document becomes QUARANTINED and a scan is queued. Idempotent.
   */
  async function complete(principal, id, req) {
    const row = await withActor(knex, principal.userId, async (trx) => {
      const { row: doc } = await authorizeDocument(
        trx,
        principal,
        id,
        PERMISSIONS.MEDICAL_RECORDS_WRITE,
        req,
      );
      if (doc.uploaded_by_user_id !== principal.userId) {
        throw new ForbiddenError('Only the uploader can complete this upload.', 'not_uploader');
      }
      return doc;
    });
    if (row.status !== 'pending_upload') return toDocumentView(row); // already completed

    const stat = await storage.statObject(row.quarantine_key);
    if (!stat) {
      throw new ConflictError('The file has not been uploaded yet.', 'upload_not_found');
    }
    const tooBig = stat.size > config.documents.maxBytes;
    const sizeWrong = stat.size !== row.declared_size_bytes;
    const result = await withSystem(knex, 'documents', async (trx) => {
      const locked = await documents.findById(trx, id, { forUpdate: true });
      if (locked.status !== 'pending_upload') return locked;
      const at = now();
      if (tooBig || sizeWrong) {
        const reason = tooBig ? 'size_exceeded' : 'size_mismatch';
        await documents.update(trx, id, {
          status: 'rejected',
          rejection_reason: reason,
          rejected_at: at,
          object_size_bytes: stat.size,
          uploaded_at: at,
        });
        await audit.record(
          {
            category: DATA,
            action: 'document.scan_rejected',
            outcome: 'failure',
            actor: principal,
            resourceType: 'medical_document',
            resourceId: id,
            patientId: locked.patient_id,
            reason,
          },
          { req, trx },
        );
        await appendOutboxEvent(trx, {
          aggregateType: 'medical_document',
          aggregateId: id,
          eventType: 'document.rejected',
          payload: { documentId: id, patientId: locked.patient_id, reason },
          requestId: req?.id ?? null,
        });
        domainMetrics.documentScanRejected.inc({ reason });
        return { ...locked, status: 'rejected', rejection_reason: reason, removeObject: true };
      }
      await documents.update(trx, id, {
        status: 'quarantined',
        uploaded_at: at,
        object_size_bytes: stat.size,
      });
      await audit.record(
        {
          category: DATA,
          action: 'document.upload_completed',
          outcome: 'success',
          actor: principal,
          resourceType: 'medical_document',
          resourceId: id,
          patientId: locked.patient_id,
          metadata: { sizeBytes: stat.size },
        },
        { req, trx },
      );
      await appendOutboxEvent(trx, {
        aggregateType: 'medical_document',
        aggregateId: id,
        eventType: 'document.uploaded',
        payload: { documentId: id, patientId: locked.patient_id },
        requestId: req?.id ?? null,
      });
      domainMetrics.documentUploadCompleted.inc();
      return { ...locked, status: 'quarantined' };
    });
    if (result.removeObject) {
      await storage
        .removeObject(row.quarantine_key)
        .catch((err) =>
          logger?.warn({ documentId: id, err: err.kind }, 'quarantine cleanup failed'),
        );
    }
    return withActor(knex, principal.userId, async (trx) =>
      toDocumentView(await documents.findById(trx, id)),
    );
  }

  // ── Read ────────────────────────────────────────────────────────

  /**
   * Metadata list. The patient side sees every document; a consented doctor sees only
   * AVAILABLE documents of the types their consents cover (enforced by RLS and again
   * here).
   */
  async function list(principal, patientId, { includeRetired = false } = {}, req) {
    return withActor(knex, principal.userId, async (trx) => {
      const decision = await authorizePatient(
        trx,
        principal,
        patientId,
        PERMISSIONS.MEDICAL_RECORDS_READ,
        req,
      );
      const self = SELF.has(decision.relationship);
      let rows = await documents.forPatient(trx, patientId, {
        includeRetired: self && includeRetired,
      });
      if (!self) {
        const allowed = await trx('consents')
          .where({ patient_id: patientId, grantee_user_id: principal.userId, status: 'active' })
          .where('expires_at', '>', trx.fn.now())
          .whereRaw("'medical_documents' = ANY (scopes)")
          .select('document_types');
        const all = allowed.some((c) => !c.document_types);
        const types = new Set(allowed.flatMap((c) => c.document_types ?? []));
        rows = rows.filter((r) => r.status === 'available' && (all || types.has(r.document_type)));
        await audit.record(
          {
            category: DATA,
            action: 'document.list_viewed',
            outcome: 'success',
            resourceType: 'patient',
            resourceId: patientId,
            patientId,
            reason: decision.relationship,
            metadata: { count: rows.length, consentId: decision.consentId ?? null },
          },
          { req, trx },
        );
      }
      return rows.map(toDocumentView);
    });
  }

  async function get(principal, id, req) {
    return withActor(knex, principal.userId, async (trx) => {
      const { decision, row } = await authorizeDocument(
        trx,
        principal,
        id,
        PERMISSIONS.MEDICAL_RECORDS_READ,
        req,
      );
      await audit.record(
        {
          category: DATA,
          action: 'document.viewed',
          outcome: 'success',
          resourceType: 'medical_document',
          resourceId: id,
          patientId: row.patient_id,
          reason: decision.relationship,
          metadata: { consentId: decision.consentId ?? null },
        },
        { req, trx },
      );
      return toDocumentView(row);
    });
  }

  /**
   * Short-lived download URL, issued only after authorisation. The URL is not the
   * authorisation: it merely carries an already-made decision for its short TTL.
   */
  async function download(principal, id, req) {
    const row = await withActor(knex, principal.userId, async (trx) => {
      const { decision, row: doc } = await authorizeDocument(
        trx,
        principal,
        id,
        PERMISSIONS.MEDICAL_RECORDS_READ,
        req,
      );
      if (doc.status !== 'available') {
        throw new ConflictError(
          doc.status === 'rejected'
            ? 'This document was rejected and cannot be downloaded.'
            : 'This document is still being checked.',
          'document_not_available',
        );
      }
      await audit.record(
        {
          category: DATA,
          action: 'document.download_authorized',
          outcome: 'success',
          resourceType: 'medical_document',
          resourceId: id,
          patientId: doc.patient_id,
          reason: decision.relationship,
          metadata: {
            ttlSeconds: config.documents.downloadUrlTtlSeconds,
            consentId: decision.consentId ?? null,
          },
        },
        { req, trx },
      );
      return doc;
    });
    domainMetrics.documentDownloads.inc();
    const { url, expiresAt } = await storage.getDownloadUrl(row.storage_key, {
      filename: row.original_filename,
      contentType: row.detected_content_type,
      ttlSeconds: config.documents.downloadUrlTtlSeconds,
    });
    return { url, expiresAt, filename: row.original_filename };
  }

  /** The patient side retires a document: hidden from everyone else; record kept. */
  async function retire(principal, id, req) {
    const row = await withActor(knex, principal.userId, async (trx) => {
      const { decision, row: doc } = await authorizeDocument(
        trx,
        principal,
        id,
        PERMISSIONS.MEDICAL_RECORDS_WRITE,
        req,
      );
      if (!SELF.has(decision.relationship)) {
        throw new ForbiddenError('Only the patient side can remove documents.', 'wrong_party');
      }
      return doc;
    });
    return withSystem(knex, 'documents', async (trx) => {
      const changed = await documents.update(
        trx,
        id,
        { status: 'retired', retired_at: now(), retired_by_user_id: principal.userId },
        { whereStatus: ['available', 'rejected'] },
      );
      if (changed !== 1) {
        throw new ConflictError('Only checked documents can be removed.', 'document_not_retirable');
      }
      await audit.record(
        {
          category: DATA,
          action: 'document.retired',
          outcome: 'success',
          actor: principal,
          resourceType: 'medical_document',
          resourceId: id,
          patientId: row.patient_id,
        },
        { req, trx },
      );
      await appendOutboxEvent(trx, {
        aggregateType: 'medical_document',
        aggregateId: id,
        eventType: 'document.retired',
        payload: { documentId: id, patientId: row.patient_id },
        requestId: req?.id ?? null,
      });
      return toDocumentView({ ...row, status: 'retired', retired_at: now() });
    });
  }

  return { createUploadIntent, complete, list, get, download, retire };
}
