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
    async askRecord(input) {
      calls.push({ kind: 'question', ...input });
      const fact = input.facts[0];
      return fact
        ? {
            status: 'answered',
            answer: fact.text,
            sentences: [
              {
                text: fact.text,
                citations: [{ label: 'F1', type: 'lab_result', id: fact.id, documentId: null }],
              },
            ],
          }
        : {
            status: 'insufficient_information',
            answer: 'Insufficient information. Please consult the doctor.',
            sentences: [],
          };
    },
    async generateBrief(input) {
      calls.push({ kind: 'brief', ...input });
      const h = getHarness();
      const runId = randomUUID();
      await h.ownerKnex('ai.ai_runs').insert({
        id: runId,
        workflow: 'doctor_brief',
        patient_id: input.patientId,
        status: 'ok',
        provider: 'fake',
      });
      const sections = input.facts.length
        ? [
            {
              heading: 'Recent verified lab values',
              sentences: input.facts.map((f, i) => ({
                text: f.text,
                citations: [{ label: `F${i + 1}`, type: 'lab_result', id: f.id, documentId: null }],
              })),
            },
          ]
        : [];
      const briefId = randomUUID();
      await h.ownerKnex('ai.doctor_briefs').insert({
        id: briefId,
        patient_id: input.patientId,
        appointment_id: input.appointmentId,
        doctor_user_id: input.doctorUserId,
        run_id: runId,
        status: sections.length ? 'ready' : 'insufficient_information',
        sections: JSON.stringify(sections),
        source_count: input.facts.length + input.documentIds.length,
        prompt_version: 'test',
      });
      return { briefId, status: sections.length ? 'ready' : 'insufficient_information' };
    },
    async summarizeFollowUp(input) {
      calls.push(input);
      const h = getHarness();
      const runId = randomUUID();
      await h.ownerKnex('ai.ai_runs').insert({
        id: runId,
        workflow: 'follow_up_summary',
        patient_id: input.patientId,
        status: 'ok',
        provider: 'fake',
      });
      const sentences = input.facts.map((f, i) => ({
        text: f.text,
        citations: [{ label: `F${i + 1}`, type: 'follow_up_response', id: f.id, documentId: null }],
      }));
      await h.ownerKnex('ai.follow_up_summaries').insert({
        id: randomUUID(),
        follow_up_id: input.followUpId,
        patient_id: input.patientId,
        doctor_user_id: input.doctorUserId,
        run_id: runId,
        status: sentences.length ? 'ready' : 'insufficient_information',
        sentences: JSON.stringify(sentences),
        prompt_version: 'test',
      });
      return { status: sentences.length ? 'ready' : 'insufficient_information', sentences };
    },
  };
}
