import { randomUUID } from 'node:crypto';

/**
 * Stand-in for the AI service (not reachable from the host by design). It writes the
 * same artifacts the real service writes — as the owner role — and returns its answer.
 * The real cross-service path is covered by the end-to-end run in Docker.
 */
export function stubAiClient(getHarness) {
  const calls = [];
  return {
    calls,
    async analyzeDocument(input) {
      calls.push(input);
      const h = getHarness();
      const existing = await h
        .ownerKnex('ai.document_extractions')
        .where({ document_id: input.documentId })
        .first();
      if (existing) return { extractionId: existing.id, reused: true };
      const runId = randomUUID();
      const extractionId = randomUUID();
      await h.ownerKnex('ai.ai_runs').insert({
        id: runId,
        workflow: 'document_analysis',
        patient_id: input.patientId,
        status: 'ok',
        provider: 'fake',
      });
      await h.ownerKnex('ai.document_extractions').insert({
        id: extractionId,
        patient_id: input.patientId,
        document_id: input.documentId,
        document_type: input.documentType,
        version: 1,
        run_id: runId,
        input_sha256: input.sha256,
        prompt_version: 'test',
        status: 'completed',
        text_source: 'pdf_text',
        classification: JSON.stringify({ documentType: 'lab_report', confidence: 0.9 }),
        fields: JSON.stringify([
          {
            key: 'document_date',
            kind: 'document_date',
            value: '2026-09-14',
            isoDate: '2026-09-14',
            quote: 'Report date: 2026-09-14',
          },
          {
            key: 'issuer',
            kind: 'issuer',
            value: 'Sunrise Diagnostics Laboratory',
            quote: 'Sunrise Diagnostics Laboratory',
          },
          {
            key: 'lab-0-hemoglobin',
            kind: 'lab_result',
            analyte: 'Hemoglobin',
            value: '13.2',
            valueNumeric: 13.2,
            unit: 'g/dL',
            referenceRange: '12.0-15.5',
            flag: 'normal',
            quote: 'Hemoglobin: 13.2 g/dL (ref 12.0-15.5)',
          },
          {
            key: 'lab-1-wbc',
            kind: 'lab_result',
            analyte: 'WBC',
            value: '11.8',
            valueNumeric: 11.8,
            unit: '10^3/uL',
            referenceRange: '4.0-11.0',
            flag: 'high',
            quote: 'WBC: 11.8 10^3/uL (ref 4.0-11.0)',
          },
        ]),
      });
      return { extractionId, reused: false };
    },
  };
}
