import { withSystem } from '../../core/db/actorContext.js';
import { appendOutboxEvent } from '../../core/events/outbox.js';
import { domainMetrics } from '../../core/metrics/domain.js';
import { validateDocumentContent } from './fileValidation.js';
import { ScannerError } from './scanning/documentScanner.js';

const DATA = 'data_access';
const SYSTEM = 'system';

/**
 * Quarantine → scan → promotion (ADR-0021), run by the `documents` worker.
 *
 *   QUARANTINED ──claim──► SCANNING ──clean + valid──► copy to records/ ──► AVAILABLE
 *                                   ├─ infected / invalid ──► REJECTED (object removed)
 *                                   └─ scanner error ──► QUARANTINED (retry with backoff)
 *
 * Idempotent and crash-safe:
 * - only QUARANTINED or SCANNING documents are processed; anything else is a no-op;
 * - the copy to the records key is idempotent (same source and target), and the status
 *   flips to AVAILABLE only in a transaction that re-checks SCANNING under a row lock,
 *   so duplicate jobs promote once and a crash between copy and commit is retried;
 * - a scanner failure never makes a document available.
 */
export function createDocumentPipeline({
  knex,
  config,
  documents,
  storage,
  scanner,
  audit,
  logger,
  now = () => new Date(),
}) {
  async function record(trx, row, action, outcome, extra = {}) {
    await audit.record(
      {
        category: DATA,
        action,
        outcome,
        actor: SYSTEM,
        resourceType: 'medical_document',
        resourceId: row.id,
        patientId: row.patient_id,
        ...extra,
      },
      { trx },
    );
  }

  async function reject(row, reason, extraMeta = {}) {
    await withSystem(knex, 'documents', async (trx) => {
      const changed = await documents.update(
        trx,
        row.id,
        {
          status: 'rejected',
          rejection_reason: reason,
          rejected_at: now(),
          scanned_at: now(),
          scanner: scanner.name,
          ...extraMeta,
        },
        { whereStatus: 'scanning' },
      );
      if (changed !== 1) return;
      await record(trx, row, 'document.scan_rejected', 'failure', { reason });
      await appendOutboxEvent(trx, {
        aggregateType: 'medical_document',
        aggregateId: row.id,
        eventType: 'document.rejected',
        payload: { documentId: row.id, patientId: row.patient_id, reason },
      });
      domainMetrics.documentScanRejected.inc({ reason });
    });
    // Rejected (possibly malicious) content is not retained.
    await storage.removeObject(row.quarantine_key).catch(() => {});
    return { outcome: 'rejected', reason };
  }

  /** @returns {Promise<{ outcome: string, reason?: string }>} */
  async function scanAndPromote(documentId) {
    const claimed = await withSystem(knex, 'documents', async (trx) => {
      const row = await documents.findById(trx, documentId, { forUpdate: true });
      if (!row || !['quarantined', 'scanning'].includes(row.status)) return null;
      await documents.update(trx, documentId, {
        status: 'scanning',
        scan_attempts: row.scan_attempts + 1,
      });
      await record(trx, row, 'document.scan_started', 'success', {
        metadata: { attempt: row.scan_attempts + 1, scanner: scanner.name },
      });
      return row;
    });
    if (!claimed) return { outcome: 'not_scannable' };
    domainMetrics.documentScanStarted.inc();

    let buffer;
    try {
      buffer = await storage.readObject(claimed.quarantine_key, config.documents.maxBytes);
    } catch (err) {
      if (err.kind === 'too_large') return reject(claimed, 'size_exceeded');
      if (err.kind === 'not_found') return reject(claimed, 'upload_missing');
      await backToQuarantine(claimed, err);
      throw err; // storage unavailable: retry
    }

    const check = validateDocumentContent({
      buffer,
      declaredContentType: claimed.declared_content_type,
      declaredSize: claimed.declared_size_bytes,
      declaredSha256: claimed.declared_sha256,
      filename: claimed.original_filename,
      maxBytes: config.documents.maxBytes,
    });
    if (!check.ok) return reject(claimed, check.reason, { object_size_bytes: check.size });

    let verdict;
    try {
      verdict = await scanner.scan(buffer);
    } catch (err) {
      if (!(err instanceof ScannerError)) throw err;
      await backToQuarantine(claimed, err);
      throw err; // retried with backoff; dead-lettered (still quarantined) if it persists
    }
    if (!verdict.clean) {
      logger?.warn({ documentId, scanner: scanner.name }, 'document rejected by scanner');
      return reject(claimed, 'infected', { object_size_bytes: check.size });
    }

    // Promotion: copy first (idempotent), then flip the status atomically.
    await storage.copyObject(claimed.quarantine_key, claimed.storage_key);
    const promoted = await withSystem(knex, 'documents', async (trx) => {
      const at = now();
      const changed = await documents.update(
        trx,
        documentId,
        {
          status: 'available',
          detected_content_type: check.detectedContentType,
          verified_sha256: check.sha256,
          object_size_bytes: check.size,
          scanner: scanner.name,
          scanned_at: at,
          available_at: at,
        },
        { whereStatus: 'scanning' },
      );
      if (changed !== 1) return false;
      await record(trx, claimed, 'document.promoted', 'success', {
        metadata: { scanner: scanner.name, contentType: check.detectedContentType },
      });
      await appendOutboxEvent(trx, {
        aggregateType: 'medical_document',
        aggregateId: documentId,
        eventType: 'document.available',
        payload: { documentId, patientId: claimed.patient_id },
      });
      return true;
    });
    if (!promoted) return { outcome: 'already_processed' };
    domainMetrics.documentScanSuccess.inc();
    domainMetrics.documentPromoted.inc();
    await storage
      .removeObject(claimed.quarantine_key)
      .catch((err) => logger?.warn({ documentId, err: err.kind }, 'quarantine cleanup failed'));
    return { outcome: 'available' };
  }

  async function backToQuarantine(row, err) {
    domainMetrics.documentScanFailed.inc();
    await withSystem(knex, 'documents', async (trx) => {
      const changed = await documents.update(
        trx,
        row.id,
        { status: 'quarantined' },
        { whereStatus: 'scanning' },
      );
      if (changed === 1) {
        await record(trx, row, 'document.scan_failed', 'failure', { reason: err.kind ?? 'error' });
      }
    });
  }

  /** Housekeeping: upload intents never completed within their window are rejected. */
  async function expireStaleIntents({ limit = 200 } = {}) {
    return withSystem(knex, 'documents', async (trx) => {
      const rows = await documents.staleIntents(trx, limit);
      for (const row of rows) {
        await documents.update(trx, row.id, {
          status: 'rejected',
          rejection_reason: 'upload_expired',
          rejected_at: now(),
        });
        await record(trx, row, 'document.scan_rejected', 'failure', { reason: 'upload_expired' });
      }
      return { expired: rows.length };
    });
  }

  return { scanAndPromote, expireStaleIntents };
}
