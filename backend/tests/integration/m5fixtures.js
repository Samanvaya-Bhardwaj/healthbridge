// M5 fixtures: synthetic documents, consent grants, uploads straight to MinIO through
// the presigned POST (as a browser would), and actor-context SQL for RLS checks.

import { createHash, randomUUID } from 'node:crypto';
import { api, expectOk } from './m2fixtures.js';
import { EICAR } from '../../src/modules/documents/scanning/documentScanner.js';

/** Synthetic, content-free test files (no real medical documents). */
export const FILES = {
  pdf: () =>
    Buffer.from(
      `%PDF-1.4\n% HealthBridge synthetic test document ${randomUUID()}\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF\n`,
    ),
  png: () =>
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from(`synthetic-png-${randomUUID()}`),
    ]),
  infectedPdf: () => Buffer.from(`%PDF-1.4\n${EICAR}\n%%EOF\n`),
  scannerFailurePdf: () => Buffer.from('%PDF-1.4\nHB-FAKE-SCANNER-FAILURE\n%%EOF\n'),
};

export const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

export function intentBody(content, overrides = {}) {
  return {
    documentType: 'lab_report',
    title: 'Synthetic blood test',
    filename: 'blood-test.pdf',
    contentType: 'application/pdf',
    sizeBytes: content.length,
    sha256: sha256(content),
    ...overrides,
  };
}

/** Uploads the bytes with the presigned POST returned by the upload intent. */
export async function postToStorage(upload, content, contentType = 'application/pdf') {
  const form = new FormData();
  for (const [key, value] of Object.entries(upload.fields)) form.append(key, value);
  form.append('file', new Blob([content], { type: contentType }));
  return fetch(upload.url, { method: 'POST', body: form });
}

/**
 * Intent → upload → complete, and optionally the scan (worker) step.
 * @returns {Promise<{ id: string, intent: object, completed?: object, scan?: object }>}
 */
export async function uploadDocument(
  h,
  who,
  patientId,
  { content = FILES.pdf(), scan = true, uploadContent, ...overrides } = {},
) {
  const intent = expectOk(
    await api(h, who).post(
      `/patients/${patientId}/documents/upload-intent`,
      intentBody(content, overrides),
    ),
    201,
  );
  const stored = await postToStorage(
    intent.upload,
    uploadContent ?? content,
    overrides.contentType ?? 'application/pdf',
  );
  if (stored.status >= 300) throw new Error(`storage upload failed: ${stored.status}`);
  const completed = expectOk(await api(h, who).post(`/documents/${intent.document.id}/complete`));
  const result = { id: intent.document.id, intent, completed };
  if (scan) result.scan = await h.container.documentPipeline.scanAndPromote(result.id);
  return result;
}

export const grant = (h, who, body) =>
  api(h, who).post('/consents', {
    kind: 'manual',
    scopes: ['medical_documents'],
    purpose: 'ongoing_care',
    expiresInDays: 30,
    ...body,
  });

export const documentRow = (h, id) => h.ownerKnex('medical_documents').where({ id }).first();

/** Runs SQL as the application role with a user actor (RLS applies, app layer bypassed). */
export const asUser = (h, userId, fn) =>
  h.knex.transaction(async (trx) => {
    await trx.raw("SELECT set_config('app.user_id', ?, true)", [userId]);
    return fn(trx);
  });
