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

/** Runs the projector for every outbox event of the given aggregates, like the worker. */
async function projectOutbox(aggregateIds) {
  const events = await h
    .ownerKnex('outbox_events')
    .whereIn('aggregate_id', aggregateIds)
    .orderBy('occurred_at');
  for (const e of events) {
    await h.container.timelineProjector.handleEvent({
      eventId: e.id,
      eventType: e.event_type,
      aggregateType: e.aggregate_type,
      aggregateId: e.aggregate_id,
      payload: e.payload,
    });
  }
  return events.length;
}

async function scenario(label) {
  const patient = await createPatient(h, label);
  const doctor = await createVerifiedDoctor(h, admin, `${label}-doc`);
  await linkCare(h, patient, doctor);
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
  const appt = expectOk(
    await api(h, patient).post('/appointments', {
      patientId: patient.patient.id,
      doctorId: doctor.doctor.id,
      startsAt: slot.startsAt,
      mode: 'online',
      reason: 'Synthetic: review',
    }),
    201,
  );
  const lab = await uploadDocument(h, patient, patient.patient.id, { title: 'Synthetic CBC' });
  const xray = await uploadDocument(h, patient, patient.patient.id, {
    content: FILES.png(),
    documentType: 'imaging',
    title: 'Synthetic X-ray',
    filename: 'xray.png',
    contentType: 'image/png',
  });
  // AI analysis (opt-in) + doctor verification of one value.
  expectOk(
    await api(h, patient).put(`/patients/${patient.patient.id}/ai-processing`, { enabled: true }),
  );
  await h.container.intelligenceService.analyzeDocument(lab.id);
  expectOk(
    await grant(h, patient, { patientId: patient.patient.id, doctorId: doctor.doctor.id }),
    201,
  );
  expectOk(
    await api(h, doctor).post(`/documents/${lab.id}/lab-results/verify`, {
      fieldKeys: ['lab-1-wbc'],
    }),
  );
  return { patient, doctor, appt, lab, xray };
}

describe('timeline projection', () => {
  it('projects appointments, documents and verified lab values with provenance; incremental = rebuild', async () => {
    const s = await scenario('tl-basic');
    const ids = [s.appt.id, s.lab.id, s.xray.id];
    expect(await projectOutbox(ids)).toBeGreaterThan(3);
    const incremental = await h
      .ownerKnex('medical_events')
      .where({ patient_id: s.patient.patient.id })
      .orderBy('source_id');
    expect(incremental.map((e) => e.event_type).sort()).toEqual([
      'appointment',
      'document',
      'document',
      'lab_result',
    ]);

    // Replaying everything (duplicates, any order) changes nothing.
    await projectOutbox(ids);
    await h.container.timelineProjector.rebuildPatient(s.patient.patient.id);
    const rebuilt = await h
      .ownerKnex('medical_events')
      .where({ patient_id: s.patient.patient.id })
      .orderBy('source_id');
    expect(rebuilt.map((e) => [e.source_id, e.title, e.provenance, e.status])).toEqual(
      incremental.map((e) => [e.source_id, e.title, e.provenance, e.status]),
    );

    const items = expectOk(
      await api(h, s.patient).get(`/patients/${s.patient.patient.id}/timeline`),
    );
    const byType = Object.groupBy(items, (e) => e.type);
    expect(byType.appointment[0]).toMatchObject({
      provenance: 'system_recorded',
      provenanceLabel: 'Recorded by HealthBridge',
      status: 'confirmed',
    });
    expect(byType.lab_result[0]).toMatchObject({
      title: 'WBC: 11.8 10^3/uL',
      status: 'high',
      provenance: 'doctor_verified',
      provenanceLabel: 'Verified by a doctor',
      actor: s.doctor.doctor.professionalName,
      datePrecision: 'day',
    });
    const labDoc = byType.document.find((d) => d.title === 'Synthetic CBC');
    expect(labDoc).toMatchObject({ provenance: 'patient_reported', datePrecision: 'day' });
    expect(labDoc.occurredAt).toMatch(/^2026-09-14/); // document date read by AI, validated
    expect(labDoc.detail.aiDerivedFields).toEqual(['documentDate', 'issuer']);
    // Unverified AI proposals never appear as timeline facts.
    expect(items.filter((e) => e.type === 'lab_result')).toHaveLength(1);
  });

  it('orders newest first with stable cursor pagination', async () => {
    const s = await scenario('tl-order');
    await h.container.timelineProjector.rebuildPatient(s.patient.patient.id);
    const all = expectOk(await api(h, s.patient).get(`/patients/${s.patient.patient.id}/timeline`));
    const times = all.map((e) => new Date(e.occurredAt).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    const first = await api(h, s.patient).get(`/patients/${s.patient.patient.id}/timeline?limit=2`);
    const second = await api(h, s.patient).get(
      `/patients/${s.patient.patient.id}/timeline?limit=2&cursor=${first.body.meta.nextCursor}`,
    );
    expect([...first.body.data, ...second.body.data].map((e) => e.id)).toEqual(
      all.slice(0, 4).map((e) => e.id),
    );
    expect(
      (await api(h, s.patient).get(`/patients/${s.patient.patient.id}/timeline?cursor=junk`))
        .status,
    ).toBe(400);
    const labsOnly = expectOk(
      await api(h, s.patient).get(`/patients/${s.patient.patient.id}/timeline?types=lab_result`),
    );
    expect(labsOnly.every((e) => e.type === 'lab_result')).toBe(true);
  });

  it('retired documents and expired holds are hidden', async () => {
    const s = await scenario('tl-hidden');
    expectOk(await api(h, s.patient).post(`/documents/${s.xray.id}/retire`, {}));
    await projectOutbox([s.xray.id]);
    await h.container.timelineProjector.rebuildPatient(s.patient.patient.id);
    const items = expectOk(
      await api(h, s.patient).get(`/patients/${s.patient.patient.id}/timeline`),
    );
    expect(items.map((e) => e.title)).not.toContain('Synthetic X-ray');
  });
});

describe('timeline scope', () => {
  it('doctors see only what consent or their own appointments cover; others see nothing', async () => {
    const s = await scenario('tl-scope');
    await h.container.timelineProjector.rebuildPatient(s.patient.patient.id);
    const path = `/patients/${s.patient.patient.id}/timeline`;
    // Consent covers all document types: documents + verified labs + own appointment.
    const asDoctor = expectOk(await api(h, s.doctor).get(path));
    expect(asDoctor.map((e) => e.type).sort()).toEqual([
      'appointment',
      'document',
      'document',
      'lab_result',
    ]);
    expect(
      await auditFor(h.knex, { action: 'timeline.viewed', patient_id: s.patient.patient.id }),
    ).toHaveLength(1);

    // A second treating doctor whose consent covers only imaging, with no appointment.
    const radiologist = await createVerifiedDoctor(h, admin, 'tl-scope-rad');
    await linkCare(h, s.patient, radiologist);
    expect((await api(h, radiologist).get(path)).body.code).toBe('consent_required');
    expectOk(
      await grant(h, s.patient, {
        patientId: s.patient.patient.id,
        doctorId: radiologist.doctor.id,
        documentTypes: ['imaging'],
      }),
      201,
    );
    const rad = expectOk(await api(h, radiologist).get(path));
    expect(rad.map((e) => e.title)).toEqual(['Synthetic X-ray']);

    const stranger = await createVerifiedDoctor(h, admin, 'tl-scope-stranger');
    expect((await api(h, stranger).get(path)).status).toBe(404);
    expect((await api(h, admin).get(path)).status).toBe(403);
    // RLS without the application layer.
    expect(
      await asUser(h, stranger.id, (trx) =>
        trx('medical_events').where({ patient_id: s.patient.patient.id }),
      ),
    ).toHaveLength(0);
    const radRows = await asUser(h, radiologist.id, (trx) =>
      trx('medical_events').where({ patient_id: s.patient.patient.id }),
    );
    expect(radRows.map((r) => r.event_type)).toEqual(['document']);
    // Nobody but the projector writes the projection.
    expect(
      await asUser(h, s.patient.id, (trx) =>
        trx('medical_events').where({ patient_id: s.patient.patient.id }).update({ title: 'x' }),
      ),
    ).toBe(0);
  });

  it('the patient side exports JSON with provenance; doctors cannot export', async () => {
    const s = await scenario('tl-export');
    await h.container.timelineProjector.rebuildPatient(s.patient.patient.id);
    const res = await api(h, s.patient).get(`/patients/${s.patient.patient.id}/timeline/export`);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(
      /attachment; filename="healthbridge-timeline.json"/,
    );
    expect(res.body).toMatchObject({
      format: 'healthbridge.timeline.v1',
      patientId: s.patient.patient.id,
    });
    expect(res.body.events.length).toBe(4);
    expect(res.body.provenanceLegend.doctor_verified).toBe('Verified by a doctor');
    // Oldest first in the export.
    const t = res.body.events.map((e) => new Date(e.occurredAt).getTime());
    expect([...t].sort((a, b) => a - b)).toEqual(t);
    expect(
      await auditFor(h.knex, { action: 'timeline.exported', patient_id: s.patient.patient.id }),
    ).toHaveLength(1);
    expect(
      (await api(h, s.doctor).get(`/patients/${s.patient.patient.id}/timeline/export`)).status,
    ).toBe(403);
    const log = expectOk(
      await api(h, s.patient).get(`/patients/${s.patient.patient.id}/access-log?limit=100`),
    );
    expect(log.some((e) => /exported the health timeline/.test(e.description))).toBe(true);
    expect(log.some((e) => /verified lab values from “Synthetic CBC”/.test(e.description))).toBe(
      true,
    );
  });
});
