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
import { FILES, asUser, grant, uploadDocument } from './m5fixtures.js';
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

const isoDate = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

async function setup(label, { optIn = true } = {}) {
  const patient = await createPatient(h, label);
  const doctor = await createVerifiedDoctor(h, admin, `${label}-doc`);
  await linkCare(h, patient, doctor);
  const lab = await uploadDocument(h, patient, patient.patient.id, { title: 'Synthetic CBC' });
  const xray = await uploadDocument(h, patient, patient.patient.id, {
    content: FILES.png(),
    documentType: 'imaging',
    title: 'Synthetic X-ray',
    filename: 'xray.png',
    contentType: 'image/png',
  });
  if (optIn) {
    expectOk(
      await api(h, patient).put(`/patients/${patient.patient.id}/ai-processing`, { enabled: true }),
    );
    await h.container.intelligenceService.analyzeDocument(lab.id);
  }
  return { patient, doctor, lab, xray };
}

async function bookWith(patient, doctor) {
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    expectOk(
      await api(h, doctor).post('/doctors/me/availability', {
        mode: 'online',
        weekday,
        startTime: '06:00',
        endTime: '22:00',
        slotMinutes: 15,
        validFrom: isoDate(-1),
      }),
      201,
    );
  }
  const [slot] = expectOk(
    await api(h, patient).get(
      `/doctors/${doctor.doctor.id}/slots?from=${isoDate(2)}&to=${isoDate(3)}`,
    ),
  );
  return expectOk(
    await api(h, patient).post('/appointments', {
      patientId: patient.patient.id,
      doctorId: doctor.doctor.id,
      startsAt: slot.startsAt,
      mode: 'online',
      reason: 'Synthetic: review',
    }),
    201,
  );
}

describe('record questions (patient-scoped RAG)', () => {
  it('requires consent, the patient opt-in and a treating doctor; never patients or admins', async () => {
    const s = await setup('rag-gate', { optIn: false });
    const path = `/patients/${s.patient.patient.id}/record-questions`;
    expect((await api(h, s.doctor).post(path, { question: 'What was the WBC?' })).body.code).toBe(
      'consent_required',
    );
    expectOk(
      await grant(h, s.patient, { patientId: s.patient.patient.id, doctorId: s.doctor.doctor.id }),
      201,
    );
    expect((await api(h, s.doctor).post(path, { question: 'What was the WBC?' })).body.code).toBe(
      'ai_processing_disabled',
    );
    expect((await api(h, s.patient).post(path, { question: 'What was the WBC?' })).status).toBe(
      403,
    );
    expect((await api(h, admin).post(path, { question: 'What was the WBC?' })).status).toBe(403);
    const stranger = await createVerifiedDoctor(h, admin, 'rag-gate-x');
    expect((await api(h, stranger).post(path, { question: 'What was the WBC?' })).status).toBe(404);
  });

  it('sends only consented documents and verified facts; the question is never stored', async () => {
    const s = await setup('rag-scope');
    // Consent limited to imaging: the lab report must not reach the AI.
    expectOk(
      await grant(h, s.patient, {
        patientId: s.patient.patient.id,
        doctorId: s.doctor.doctor.id,
        documentTypes: ['imaging'],
      }),
      201,
    );
    const before = ai.calls.length;
    const res = expectOk(
      await api(h, s.doctor).post(`/patients/${s.patient.patient.id}/record-questions`, {
        question: 'Secret question about WBC?',
      }),
    );
    const sent = ai.calls.slice(before).find((c) => c.kind === 'question');
    expect(sent.documentIds).toEqual([s.xray.id]);
    expect(sent.facts).toEqual([]); // lab values come from a lab report outside the consent
    expect(res).toMatchObject({
      status: 'insufficient_information',
      answer: 'Insufficient information. Please consult the doctor.',
      source: 'ai_generated',
    });
    const audits = await auditFor(h.knex, {
      action: 'record.question_answered',
      patient_id: s.patient.patient.id,
    });
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0])).not.toMatch(/Secret question/);
  });

  it('answers cite verified facts with readable labels', async () => {
    const s = await setup('rag-answer');
    expectOk(
      await grant(h, s.patient, { patientId: s.patient.patient.id, doctorId: s.doctor.doctor.id }),
      201,
    );
    expectOk(
      await api(h, s.doctor).post(`/documents/${s.lab.id}/lab-results/verify`, {
        fieldKeys: ['lab-1-wbc'],
      }),
    );
    const res = expectOk(
      await api(h, s.doctor).post(`/patients/${s.patient.patient.id}/record-questions`, {
        question: 'What was the WBC?',
      }),
    );
    expect(res.status).toBe('answered');
    expect(res.sentences[0].citations[0]).toMatchObject({
      type: 'lab_result',
      title: 'Verified lab value: WBC',
    });
    const sent = ai.calls.filter((c) => c.kind === 'question').at(-1);
    expect(sent.documentIds.sort()).toEqual([s.lab.id, s.xray.id].sort());
    expect(sent.facts[0].text).toMatch(/^WBC: 11.8 10\^3\/uL \(high\).*verified by a doctor$/);
  });
});

describe('doctor brief', () => {
  it('only for the doctor’s own appointment; generated once, cached, refreshable; feedback is stored', async () => {
    const s = await setup('brief');
    const appt = await bookWith(s.patient, s.doctor);
    expectOk(
      await grant(h, s.patient, { patientId: s.patient.patient.id, doctorId: s.doctor.doctor.id }),
      201,
    );
    expectOk(
      await api(h, s.doctor).post(`/documents/${s.lab.id}/lab-results/verify`, {
        fieldKeys: ['lab-0-hemoglobin', 'lab-1-wbc'],
      }),
    );
    const path = `/appointments/${appt.id}/brief`;

    const other = await createVerifiedDoctor(h, admin, 'brief-other');
    await linkCare(h, s.patient, other);
    expect((await api(h, other).post(path, {})).status).toBe(404);
    expect((await api(h, s.patient).post(path, {})).status).toBe(404);

    const first = expectOk(await api(h, s.doctor).post(path, {}));
    expect(first).toMatchObject({ status: 'ready', source: 'ai_generated' });
    expect(first.sections[0].sentences).toHaveLength(2);
    const briefCalls = ai.calls.filter((c) => c.kind === 'brief' && c.appointmentId === appt.id);
    expect(briefCalls).toHaveLength(1);
    expect(briefCalls[0].doctorUserId).toBe(s.doctor.id);
    const again = expectOk(await api(h, s.doctor).post(path, {}));
    expect(again.id).toBe(first.id); // cached
    expect(ai.calls.filter((c) => c.kind === 'brief' && c.appointmentId === appt.id)).toHaveLength(
      1,
    );
    const refreshed = expectOk(await api(h, s.doctor).post(path, { refresh: true }));
    expect(refreshed.id).not.toBe(first.id);

    expectOk(
      await api(h, s.doctor).post(`/briefs/${refreshed.id}/feedback`, {
        rating: 'not_helpful',
        issue: 'missing_information',
      }),
    );
    expectOk(
      await api(h, s.doctor).post(`/briefs/${refreshed.id}/feedback`, { rating: 'helpful' }),
    );
    expect(await h.ownerKnex('brief_feedback').where({ brief_id: refreshed.id })).toHaveLength(1);
    expect(
      (await api(h, other).post(`/briefs/${refreshed.id}/feedback`, { rating: 'helpful' })).status,
    ).toBe(404);
    expect(
      await auditFor(h.knex, { action: 'brief.generated', resource_id: appt.id }),
    ).toHaveLength(2);

    // RLS: another doctor cannot read the brief; revoking consent hides it from its doctor.
    expect(
      await asUser(h, other.id, (trx) =>
        trx('ai.doctor_briefs').where({ appointment_id: appt.id }),
      ),
    ).toHaveLength(0);
    const consents = expectOk(
      await api(h, s.patient).get(`/consents?patientId=${s.patient.patient.id}`),
    );
    for (const c of consents.filter((x) => x.status === 'active')) {
      expectOk(await api(h, s.patient).post(`/consents/${c.id}/revoke`, {}));
    }
    expect(
      await asUser(h, s.doctor.id, (trx) =>
        trx('ai.doctor_briefs').where({ appointment_id: appt.id }),
      ),
    ).toHaveLength(0);
    expect((await api(h, s.doctor).post(path, {})).body.code).toBe('consent_required');
  });
});
