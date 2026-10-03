import { DOCUMENT_TYPES, PERMISSIONS } from '@healthbridge/shared';
import { isUuid, newId } from '../../core/db/ids.js';
import { withActor, withSystem } from '../../core/db/actorContext.js';
import { appendOutboxEvent } from '../../core/events/outbox.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../core/http/errors.js';
import { domainMetrics } from '../../core/metrics/domain.js';

const DATA = 'data_access';
const SELF = new Set(['patient_self', 'guardian_dependent']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Extraction proposal as shown to people: always labelled as AI output. */
export function toExtractionView(extraction, metadata, verifiedKeys = new Set()) {
  if (!extraction) return null;
  return {
    extractionId: extraction.id,
    version: extraction.version,
    status: extraction.status,
    textSource: extraction.text_source,
    source: 'ai_extracted',
    needsReview: extraction.status !== 'completed',
    injectionWarning: (extraction.injection_flags ?? []).length > 0,
    classification: extraction.classification,
    documentDate: metadata?.document_date ?? null,
    issuer: metadata?.issuer ?? null,
    droppedFieldCount: extraction.dropped_field_count,
    labResults: (extraction.fields ?? [])
      .filter((f) => f.kind === 'lab_result')
      .map((f) => ({
        key: f.key,
        analyte: f.analyte,
        value: f.value,
        unit: f.unit ?? null,
        referenceRange: f.referenceRange ?? null,
        flag: f.flag ?? null,
        quote: f.quote,
        verified: verifiedKeys.has(f.key),
      })),
    createdAt: extraction.created_at,
  };
}

/** Validated, non-clinical metadata from a grounded extraction (backend commits it). */
export function metadataFromExtraction(extraction) {
  const fields = extraction.fields ?? [];
  const date = fields.find((f) => f.kind === 'document_date');
  const issuer = fields.find((f) => f.kind === 'issuer');
  const cls = extraction.classification ?? {};
  const confidence = Number(cls.confidence);
  return {
    detected_type: DOCUMENT_TYPES.includes(cls.documentType) ? cls.documentType : null,
    detected_confidence:
      Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 ? confidence : null,
    document_date: date?.isoDate && ISO_DATE.test(date.isoDate) ? date.isoDate : null,
    issuer: typeof issuer?.value === 'string' ? issuer.value.slice(0, 160) : null,
    proposed_field_count: fields.filter((f) => f.kind === 'lab_result').length,
  };
}

/**
 * Document intelligence (ADR-0022): AI proposes → backend validates → backend commits.
 *
 * - `analyzeDocument` (documents worker): only AVAILABLE documents of patients who opted
 *   in; the file goes to the AI service with a patient scope token; the AI service
 *   stores grounded proposals in the `ai` schema; the backend then commits validated,
 *   non-clinical metadata (versioned). Idempotent end to end.
 * - Lab values become part of the record only when a consented treating doctor verifies
 *   them (`verifyLabResults`); values are copied server-side from the grounded proposal.
 */
export function createIntelligenceService({
  knex,
  config,
  aiClient,
  storage,
  documents,
  accessPolicy,
  audit,
  logger,
}) {
  // ── Worker ──────────────────────────────────────────────────────

  async function analyzeDocument(documentId, { requestId } = {}) {
    const doc = await withSystem(knex, 'documents', async (trx) => {
      const row = await documents.findById(trx, documentId);
      if (!row || row.status !== 'available') return { skip: 'not_available' };
      const { rows } = await trx.raw('SELECT authz.ai_processing_enabled(?) AS enabled', [
        row.patient_id,
      ]);
      if (!rows[0].enabled) return { skip: 'not_opted_in' };
      return { row };
    });
    if (doc.skip) return { outcome: doc.skip };
    const { row } = doc;
    if (!aiClient) throw new Error('AI service client not configured');

    const content = await storage.readObject(row.storage_key, config.documents.maxBytes);
    const extraction = await aiClient.analyzeDocument(
      {
        patientId: row.patient_id,
        documentId: row.id,
        documentType: row.document_type,
        contentType: row.detected_content_type,
        sha256: row.verified_sha256,
        contentBase64: content.toString('base64'),
      },
      { requestId },
    );
    return promote(row, extraction.extractionId);
  }

  /** Commits validated metadata for an extraction (idempotent per extraction). */
  async function promote(row, extractionId) {
    return withSystem(knex, 'documents', async (trx) => {
      const existing = await trx('document_metadata')
        .where({ extraction_id: extractionId })
        .first();
      if (existing) return { outcome: 'already_promoted', version: existing.version };
      const extraction = await trx('ai.document_extractions')
        .where({ id: extractionId, document_id: row.id, patient_id: row.patient_id })
        .first();
      if (!extraction) throw new ConflictError('Extraction not found for this document.');
      const current = await trx('document_metadata')
        .where({ document_id: row.id })
        .max({ v: 'version' })
        .first();
      const version = Number(current?.v ?? 0) + 1;
      await trx('document_metadata')
        .where({ document_id: row.id, is_current: true })
        .update({ is_current: false });
      const metadata = metadataFromExtraction(extraction);
      await trx('document_metadata').insert({
        id: newId(),
        document_id: row.id,
        patient_id: row.patient_id,
        document_type: row.document_type,
        version,
        extraction_id: extraction.id,
        extraction_status: extraction.status,
        ...metadata,
      });
      await audit.record(
        {
          category: DATA,
          action: 'document.ai_extracted',
          outcome: extraction.status === 'failed' ? 'failure' : 'success',
          actor: 'system',
          resourceType: 'medical_document',
          resourceId: row.id,
          patientId: row.patient_id,
          reason: extraction.status,
          metadata: {
            version,
            proposedFields: metadata.proposed_field_count,
            droppedFields: extraction.dropped_field_count,
            injectionFlags: (extraction.injection_flags ?? []).length,
          },
        },
        { trx },
      );
      await appendOutboxEvent(trx, {
        aggregateType: 'medical_document',
        aggregateId: row.id,
        eventType: 'document.analyzed',
        payload: { documentId: row.id, patientId: row.patient_id, version },
      });
      domainMetrics.documentsAnalyzed.inc({ status: extraction.status });
      logger?.info({ documentId: row.id, status: extraction.status, version }, 'document analysed');
      return { outcome: 'promoted', version, status: extraction.status };
    });
  }

  // ── People ──────────────────────────────────────────────────────

  async function authorizeDocument(trx, principal, documentId, permission, req) {
    if (!isUuid(documentId)) throw new NotFoundError();
    const ref = await documents.ref(trx, documentId);
    const decision = await accessPolicy.enforce({
      principal,
      permission,
      resource: {
        type: 'medical_document',
        id: documentId,
        patientId: ref?.patient_id,
        documentType: ref?.document_type,
        status: ref?.status,
        uploadedByUserId: ref?.uploaded_by_user_id,
      },
      req,
      trx,
    });
    const row = await documents.findById(trx, documentId);
    if (!row) throw new NotFoundError();
    return { decision, row };
  }

  async function latest(trx, documentId) {
    const extraction = await trx('ai.document_extractions')
      .where({ document_id: documentId })
      .orderBy('version', 'desc')
      .first();
    if (!extraction) return { extraction: null };
    const metadata = await trx('document_metadata').where({ extraction_id: extraction.id }).first();
    const verified = await trx('lab_results')
      .where({ extraction_id: extraction.id })
      .select('field_key');
    return { extraction, metadata, verifiedKeys: new Set(verified.map((v) => v.field_key)) };
  }

  /** AI proposals for a document (patient side, or a consented doctor). */
  async function getExtraction(principal, documentId, req) {
    return withActor(knex, principal.userId, async (trx) => {
      const { decision, row } = await authorizeDocument(
        trx,
        principal,
        documentId,
        PERMISSIONS.MEDICAL_RECORDS_READ,
        req,
      );
      const { extraction, metadata, verifiedKeys } = await latest(trx, documentId);
      await audit.record(
        {
          category: DATA,
          action: 'document.extraction_viewed',
          outcome: 'success',
          resourceType: 'medical_document',
          resourceId: documentId,
          patientId: row.patient_id,
          reason: decision.relationship,
        },
        { req, trx },
      );
      return toExtractionView(extraction, metadata, verifiedKeys);
    });
  }

  /**
   * Human promotion: a consented treating doctor verifies selected proposals. Only keys
   * are accepted from the client; values are copied from the grounded proposal.
   */
  async function verifyLabResults(principal, documentId, { fieldKeys }, req) {
    return withActor(knex, principal.userId, async (trx) => {
      const { decision, row } = await authorizeDocument(
        trx,
        principal,
        documentId,
        PERMISSIONS.LAB_RESULTS_VERIFY,
        req,
      );
      if (decision.relationship !== 'treating_doctor') {
        throw new ForbiddenError('Lab values are verified by the treating doctor.', 'wrong_party');
      }
      const { extraction, metadata, verifiedKeys } = await latest(trx, documentId);
      if (!extraction || extraction.status === 'failed') {
        throw new ConflictError('There is nothing to verify for this document.', 'no_extraction');
      }
      const proposals = new Map(
        (extraction.fields ?? []).filter((f) => f.kind === 'lab_result').map((f) => [f.key, f]),
      );
      const unknown = fieldKeys.filter((k) => !proposals.has(k));
      if (unknown.length) {
        throw new ConflictError('Some values are not part of this extraction.', 'unknown_field');
      }
      const created = [];
      const createdIds = [];
      for (const key of fieldKeys) {
        if (verifiedKeys.has(key)) continue;
        const f = proposals.get(key);
        const numeric = Number(f.valueNumeric);
        const labId = newId();
        createdIds.push(labId);
        await trx('lab_results')
          .insert({
            id: labId,
            patient_id: row.patient_id,
            document_id: row.id,
            document_type: row.document_type,
            extraction_id: extraction.id,
            field_key: key,
            analyte: String(f.analyte).slice(0, 120),
            value_numeric: Number.isFinite(numeric) ? numeric : null,
            value_text: String(f.value).slice(0, 60),
            unit: f.unit ? String(f.unit).slice(0, 30) : null,
            reference_range: f.referenceRange ? String(f.referenceRange).slice(0, 60) : null,
            flag: ['low', 'normal', 'high'].includes(f.flag) ? f.flag : null,
            observed_on: metadata?.document_date ?? null,
            source_quote: String(f.quote).slice(0, 500),
            verified_by_user_id: principal.userId,
          })
          .onConflict(['extraction_id', 'field_key'])
          .ignore();
        created.push(key);
      }
      if (created.length) {
        await audit.record(
          {
            category: DATA,
            action: 'lab_result.verified',
            outcome: 'success',
            resourceType: 'medical_document',
            resourceId: row.id,
            patientId: row.patient_id,
            reason: 'treating_doctor',
            metadata: { count: created.length, extractionVersion: extraction.version },
          },
          { req, trx },
        );
        await appendOutboxEvent(trx, {
          aggregateType: 'medical_document',
          aggregateId: row.id,
          eventType: 'lab_result.verified',
          payload: { documentId: row.id, patientId: row.patient_id, labResultIds: createdIds },
          requestId: req?.id ?? null,
        });
        domainMetrics.labResultsVerified.inc(created.length);
      }
      return { verified: created.length, alreadyVerified: fieldKeys.length - created.length };
    });
  }

  async function listLabResults(principal, patientId, req) {
    if (!isUuid(patientId)) throw new NotFoundError();
    return withActor(knex, principal.userId, async (trx) => {
      await accessPolicy.enforce({
        principal,
        permission: PERMISSIONS.MEDICAL_RECORDS_READ,
        resource: { type: 'patient', id: patientId, patientId },
        req,
        trx,
      });
      const rows = await trx('lab_results as l')
        .leftJoin('doctors as d', 'd.user_id', 'l.verified_by_user_id')
        .where('l.patient_id', patientId)
        .orderBy([{ column: 'l.observed_on', order: 'desc', nulls: 'last' }, 'l.analyte'])
        .limit(500)
        .select('l.*', 'd.professional_name as verifier_name');
      return rows.map((r) => ({
        id: r.id,
        documentId: r.document_id,
        analyte: r.analyte,
        value: r.value_text,
        valueNumeric: r.value_numeric === null ? null : Number(r.value_numeric),
        unit: r.unit,
        referenceRange: r.reference_range,
        flag: r.flag,
        observedOn: r.observed_on,
        sourceQuote: r.source_quote,
        verifiedBy: r.verifier_name,
        verifiedAt: r.verified_at,
      }));
    });
  }

  /** Patient side switches AI processing on/off; switching on queues existing documents. */
  async function setAiProcessing(principal, patientId, { enabled }, req) {
    if (!isUuid(patientId)) throw new NotFoundError();
    return withActor(knex, principal.userId, async (trx) => {
      const decision = await accessPolicy.enforce({
        principal,
        permission: PERMISSIONS.PATIENTS_WRITE,
        resource: { type: 'patient', id: patientId, patientId },
        req,
        trx,
      });
      if (!SELF.has(decision.relationship)) throw new ForbiddenError();
      const changed = await trx('patients')
        .where({ id: patientId })
        .update({ ai_document_processing: enabled, ai_processing_changed_at: trx.fn.now() });
      if (changed !== 1) throw new NotFoundError();
      let queued = 0;
      if (enabled) {
        const pending = await trx('medical_documents as m')
          .where({ 'm.patient_id': patientId, 'm.status': 'available' })
          .whereNotExists(
            trx('ai.document_extractions as e').whereRaw('e.document_id = m.id').select(1),
          )
          .select('m.id');
        for (const { id } of pending) {
          await appendOutboxEvent(trx, {
            aggregateType: 'medical_document',
            aggregateId: id,
            eventType: 'document.analysis_requested',
            payload: { documentId: id, patientId },
            requestId: req?.id ?? null,
          });
        }
        queued = pending.length;
      }
      await audit.record(
        {
          category: DATA,
          action: 'patient.ai_processing_changed',
          outcome: 'success',
          resourceType: 'patient',
          resourceId: patientId,
          patientId,
          reason: enabled ? 'enabled' : 'disabled',
          metadata: { queued },
        },
        { req, trx },
      );
      return { enabled, queued };
    });
  }

  async function getAiProcessing(principal, patientId, req) {
    if (!isUuid(patientId)) throw new NotFoundError();
    return withActor(knex, principal.userId, async (trx) => {
      const decision = await accessPolicy.enforce({
        principal,
        permission: PERMISSIONS.PATIENTS_READ,
        resource: { type: 'patient', id: patientId, patientId },
        req,
        trx,
      });
      if (!SELF.has(decision.relationship)) throw new ForbiddenError();
      const row = await trx('patients')
        .where({ id: patientId })
        .first('ai_document_processing', 'ai_processing_changed_at');
      return { enabled: row.ai_document_processing, changedAt: row.ai_processing_changed_at };
    });
  }

  return {
    analyzeDocument,
    promote,
    getExtraction,
    verifyLabResults,
    listLabResults,
    setAiProcessing,
    getAiProcessing,
  };
}
