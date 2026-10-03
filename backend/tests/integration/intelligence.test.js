import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditFor, createHarness } from './harness.js';
import {
  api,
  createPatient,
  createPlatformAdmin,
  createVerifiedDoctor,
  expectOk,
  linkCare,
} from './m2fixtures.js';
import { asUser, grant, uploadDocument } from './m5fixtures.js';
import { stubAiClient } from './m6fixtures.js';

let h;
let admin;
const ai = stubAiClient(() => h);
beforeAll(async () => {
  h = await createHarness({ aiClient: ai });
  admin = await createPlatformAdmin(h);
});
afterAll(async () => {
  await h.close();
});

async function setup(label) {
  const patient = await createPatient(h, label);
  const doctor = await createVerifiedDoctor(h, admin, `${label}-doc`);
  await linkCare(h, patient, doctor);
  const doc = await uploadDocument(h, patient, patient.patient.id, { title: 'Synthetic CBC' });
  return { patient, doctor, docId: doc.id };
}

describe('AI document analysis (opt-in, proposals, validated metadata)', () => {
  it('does nothing until the patient opts in; then proposes and commits metadata once', async () => {
    const { patient, docId } = await setup('ai-optin');
    const intel = h.container.intelligenceService;
    expect((await intel.analyzeDocument(docId)).outcome).toBe('not_opted_in');
    expect(ai.calls.filter((c) => c.documentId === docId)).toHaveLength(0);

    const res = expectOk(
      await api(h, patient).put(`/patients/${patient.patient.id}/ai-processing`, { enabled: true }),
    );
    expect(res).toEqual({ enabled: true, queued: 1 });
    // The opt-in queued the existing document for analysis (outbox).
    const queued = await h
      .ownerKnex('outbox_events')
      .where({ aggregate_id: docId, event_type: 'document.analysis_requested' });
    expect(queued).toHaveLength(1);

    expect(await intel.analyzeDocument(docId)).toMatchObject({ outcome: 'promoted', version: 1 });
    expect((await intel.analyzeDocument(docId)).outcome).toBe('already_promoted');
    const call = ai.calls.find((c) => c.documentId === docId);
    expect(call).toMatchObject({ patientId: patient.patient.id, contentType: 'application/pdf' });
    const meta = await h.ownerKnex('document_metadata').where({ document_id: docId });
    expect(meta).toHaveLength(1);
    expect(meta[0]).toMatchObject({
      detected_type: 'lab_report',
      issuer: 'Sunrise Diagnostics Laboratory',
      is_current: true,
    });
    expect(meta[0].document_date).toBe('2026-09-14');
    expect(
      await auditFor(h.knex, { action: 'document.ai_extracted', resource_id: docId }),
    ).toHaveLength(1);

    const view = expectOk(await api(h, patient).get(`/documents/${docId}/extraction`));
    expect(view).toMatchObject({
      source: 'ai_extracted',
      status: 'completed',
      issuer: 'Sunrise Diagnostics Laboratory',
    });
    expect(view.labResults.map((l) => [l.analyte, l.flag, l.verified])).toEqual([
      ['Hemoglobin', 'normal', false],
      ['WBC', 'high', false],
    ]);
  });

  it('a consented doctor verifies values; values come from the proposal, not the client', async () => {
    const { patient, doctor, docId } = await setup('ai-verify');
    expectOk(
      await api(h, patient).put(`/patients/${patient.patient.id}/ai-processing`, { enabled: true }),
    );
    await h.container.intelligenceService.analyzeDocument(docId);
    const path = `/documents/${docId}/lab-results/verify`;

    // Without consent: no access to proposals or verification.
    expect((await api(h, doctor).get(`/documents/${docId}/extraction`)).body.code).toBe(
      'consent_required',
    );
    expect((await api(h, doctor).post(path, { fieldKeys: ['lab-1-wbc'] })).body.code).toBe(
      'consent_required',
    );
    expectOk(
      await grant(h, patient, { patientId: patient.patient.id, doctorId: doctor.doctor.id }),
      201,
    );

    // The patient cannot verify their own values (no permission).
    expect((await api(h, patient).post(path, { fieldKeys: ['lab-1-wbc'] })).status).toBe(403);
    // Client-supplied values are not accepted at all.
    expect(
      (await api(h, doctor).post(path, { fieldKeys: ['lab-1-wbc'], value: '4.0' })).status,
    ).toBe(400);
    expect((await api(h, doctor).post(path, { fieldKeys: ['lab-9-fake'] })).body.code).toBe(
      'unknown_field',
    );

    expect(expectOk(await api(h, doctor).post(path, { fieldKeys: ['lab-1-wbc'] }))).toEqual({
      verified: 1,
      alreadyVerified: 0,
    });
    expect(
      expectOk(await api(h, doctor).post(path, { fieldKeys: ['lab-1-wbc', 'lab-0-hemoglobin'] })),
    ).toEqual({
      verified: 1,
      alreadyVerified: 1,
    });
    const labs = expectOk(await api(h, patient).get(`/patients/${patient.patient.id}/lab-results`));
    const wbc = labs.find((l) => l.analyte === 'WBC');
    expect(wbc).toMatchObject({
      value: '11.8',
      flag: 'high',
      unit: '10^3/uL',
      verifiedBy: doctor.doctor.professionalName,
      observedOn: expect.any(String),
    });
    expect(wbc.sourceQuote).toBe('WBC: 11.8 10^3/uL (ref 4.0-11.0)');
    expect(
      await auditFor(h.knex, { action: 'lab_result.verified', resource_id: docId }),
    ).toHaveLength(2);
    // Verified values are immutable, for every role.
    await expect(
      h.ownerKnex('lab_results').where({ document_id: docId }).update({ value_text: '1' }),
    ).rejects.toThrow(/immutable/);
  });

  it('isolation: strangers, other patients and admins see nothing; RLS agrees', async () => {
    const { patient, docId } = await setup('ai-iso');
    expectOk(
      await api(h, patient).put(`/patients/${patient.patient.id}/ai-processing`, { enabled: true }),
    );
    await h.container.intelligenceService.analyzeDocument(docId);
    const stranger = await createVerifiedDoctor(h, admin, 'ai-iso-stranger');
    const other = await createPatient(h, 'ai-iso-other');
    expect((await api(h, stranger).get(`/documents/${docId}/extraction`)).status).toBe(404);
    expect((await api(h, other).get(`/documents/${docId}/extraction`)).status).toBe(404);
    expect((await api(h, admin).get(`/documents/${docId}/extraction`)).status).toBe(403);
    expect((await api(h, other).get(`/patients/${patient.patient.id}/lab-results`)).status).toBe(
      404,
    );
    expect(
      (await api(h, other).put(`/patients/${patient.patient.id}/ai-processing`, { enabled: false }))
        .status,
    ).toBe(404);
    // Database layer: the application role never reads chunks or runs, nor writes AI tables.
    expect(await asUser(h, patient.id, (trx) => trx('ai.document_chunks'))).toHaveLength(0);
    expect(await asUser(h, patient.id, (trx) => trx('ai.ai_runs'))).toHaveLength(0);
    await expect(
      asUser(h, patient.id, (trx) =>
        trx('ai.document_extractions').insert({
          id: randomUUID(),
          patient_id: patient.patient.id,
          document_id: docId,
          document_type: 'other',
          version: 9,
          run_id: randomUUID(),
          input_sha256: 'a'.repeat(64),
          prompt_version: 'x',
          status: 'completed',
          text_source: 'none',
        }),
      ),
    ).rejects.toThrow(/permission denied/);
    expect(
      await asUser(h, stranger.id, (trx) =>
        trx('ai.document_extractions').where({ document_id: docId }),
      ),
    ).toHaveLength(0);
    expect(
      await asUser(h, stranger.id, (trx) => trx('document_metadata').where({ document_id: docId })),
    ).toHaveLength(0);
    // Lab values cannot be inserted without consent, even by a treating doctor directly.
    await expect(
      asUser(h, stranger.id, (trx) =>
        trx('lab_results').insert({
          id: randomUUID(),
          patient_id: patient.patient.id,
          document_id: docId,
          document_type: 'lab_report',
          extraction_id: randomUUID(),
          field_key: 'x',
          analyte: 'x',
          value_text: '1',
          source_quote: 'x',
          verified_by_user_id: stranger.id,
        }),
      ),
    ).rejects.toThrow();
  });

  it('opt-out stops new analysis; turning it on again only queues unanalysed documents', async () => {
    const { patient, docId } = await setup('ai-optout');
    expectOk(
      await api(h, patient).put(`/patients/${patient.patient.id}/ai-processing`, { enabled: true }),
    );
    await h.container.intelligenceService.analyzeDocument(docId);
    expectOk(
      await api(h, patient).put(`/patients/${patient.patient.id}/ai-processing`, {
        enabled: false,
      }),
    );
    const second = await uploadDocument(h, patient, patient.patient.id, { title: 'Second' });
    expect((await h.container.intelligenceService.analyzeDocument(second.id)).outcome).toBe(
      'not_opted_in',
    );
    expect(
      expectOk(await api(h, patient).get(`/patients/${patient.patient.id}/ai-processing`)).enabled,
    ).toBe(false);
    const again = expectOk(
      await api(h, patient).put(`/patients/${patient.patient.id}/ai-processing`, { enabled: true }),
    );
    expect(again.queued).toBe(1); // only the unanalysed second document
  });
});
