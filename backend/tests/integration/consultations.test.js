import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditFor, createHarness } from './harness.js';
import {
  api,
  createClinicWithAdmin,
  createPatient,
  createPlatformAdmin,
  createVerifiedDoctor,
  expectOk,
  linkCare,
} from './m2fixtures.js';
import { bookSlot, outboxOf, publishPaidWeek } from './m4fixtures.js';
import { asUser, grant } from './m5fixtures.js';
import { templateForEvent } from '../../src/modules/notifications/notificationService.js';

// Consultation rules depend on the appointment time: the services read this clock.
let offsetMs = 0;
const clock = () => new Date(Date.now() + offsetMs);
const travelTo = (iso, minutes = 0) => {
  offsetMs = new Date(iso).getTime() + minutes * 60_000 - Date.now();
};
/** Privileged (admin) sessions idle out after 12 hours: use them at the real time. */
async function atRealTime(fn) {
  const saved = offsetMs;
  offsetMs = 0;
  try {
    return await fn();
  } finally {
    offsetMs = saved;
  }
}

let h;
let admin;
beforeAll(async () => {
  h = await createHarness({ now: clock });
  admin = await createPlatformAdmin(h);
});
afterAll(async () => {
  await h.close();
});

const NOTE = {
  subjective: 'Synthetic: sore throat for two days, no breathlessness.',
  objective: 'Synthetic: afebrile on video, throat mildly red.',
  assessment: 'Synthetic: likely viral pharyngitis.',
  plan: 'Synthetic: symptomatic care, review if worse.',
};
const ITEMS = [
  {
    drugName: 'Paracetamol',
    strength: '500 mg',
    form: 'tablet',
    dose: '1 tablet',
    frequency: 'every 6 hours if needed',
    route: 'oral',
    duration: '3 days',
    instructions: 'After food. Max 4 tablets a day.',
  },
  {
    drugName: 'Warm saline gargle',
    dose: '1 glass',
    frequency: 'three times a day',
    route: 'other',
    duration: '5 days',
  },
];

/** Free online appointment, two days ahead, with the clock moved to just before it. */
async function liveSetup(label, { start = true, mode = 'online' } = {}) {
  offsetMs = 0;
  const doctor = await createVerifiedDoctor(h, admin, `${label}-doc`);
  let clinicId;
  if (mode === 'in_clinic') {
    const { clinic, clinicAdmin } = await createClinicWithAdmin(h, admin, `${label}-clinic`);
    const invite = expectOk(
      await api(h, clinicAdmin).post(`/clinics/${clinic.id}/doctors`, {
        doctorId: doctor.doctor.id,
      }),
      201,
    );
    expectOk(await api(h, doctor).post(`/clinic-memberships/${invite.id}/accept`));
    clinicId = clinic.id;
  }
  await publishPaidWeek(h, doctor, { feePaise: 0, mode, clinicId });
  const patient = await createPatient(h, `${label}-pt`);
  await linkCare(h, patient, doctor);
  const appt = await bookSlot(h, patient, doctor, { mode });
  travelTo(appt.startsAt, -5);
  if (start) expectOk(await api(h, doctor).post(`/appointments/${appt.id}/consultation/start`));
  return { doctor, patient, appt };
}

const consult = (who, apptId, suffix = '') =>
  api(h, who).get(`/appointments/${apptId}/consultation${suffix}`);

describe('waiting room and start', () => {
  it('opens 15 minutes before; the doctor sees the patient waiting; only the doctor starts', async () => {
    const { doctor, patient, appt } = await liveSetup('wait', { start: false });
    const stranger = await createPatient(h, 'wait-stranger');

    travelTo(appt.startsAt, -30);
    const early = await api(h, patient).post(`/appointments/${appt.id}/waiting-room`);
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('waiting_room_closed');

    travelTo(appt.startsAt, -5);
    const joined = expectOk(await api(h, patient).post(`/appointments/${appt.id}/waiting-room`));
    expect(joined.waitingRoom).toMatchObject({ open: true, patientPresent: true });
    const seen = expectOk(await consult(doctor, appt.id, '/status'));
    expect(seen).toMatchObject({ party: 'doctor', consultation: null });
    expect(seen.waitingRoom.patientPresent).toBe(true);

    expect((await consult(stranger, appt.id, '/status')).status).toBe(404);
    expect((await atRealTime(() => consult(admin, appt.id, '/status'))).status).toBe(403);
    const byPatient = await api(h, patient).post(`/appointments/${appt.id}/consultation/start`);
    expect(byPatient.status).toBe(403);

    const started = expectOk(
      await api(h, doctor).post(`/appointments/${appt.id}/consultation/start`),
    );
    expect(started.consultation).toMatchObject({ status: 'live', video: true });
    expect(started.appointment.status).toBe('in_consultation');
    // Idempotent.
    expectOk(await api(h, doctor).post(`/appointments/${appt.id}/consultation/start`));
    expect(await outboxOf(h, appt.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event_type: 'appointment.in_consultation' }),
      ]),
    );

    // Video grants: one per participant, short-lived, opaque identities.
    const doctorGrant = expectOk(
      await api(h, doctor).post(`/appointments/${appt.id}/consultation/join`),
    );
    const patientGrant = expectOk(
      await api(h, patient).post(`/appointments/${appt.id}/consultation/join`),
    );
    expect(doctorGrant).toMatchObject({ provider: 'mock' });
    expect(doctorGrant.room).toBe(patientGrant.room);
    expect(doctorGrant.token).not.toBe(patientGrant.token);
    expect(doctorGrant.room).not.toContain(appt.id);
    expect((await api(h, stranger).post(`/appointments/${appt.id}/consultation/join`)).status).toBe(
      404,
    );

    // The generic "complete" action cannot bypass the outcome.
    const bypass = await api(h, doctor).post(`/appointments/${appt.id}/complete`);
    expect(bypass.status).toBe(409);
  });
});

describe('SOAP notes', () => {
  it('encrypts drafts, shows the patient only signed notes and corrects by new version', async () => {
    const { doctor, patient, appt } = await liveSetup('note');
    const saved = expectOk(
      await api(h, doctor).put(`/appointments/${appt.id}/consultation/note`, NOTE),
    );
    expect(saved.notes).toEqual([expect.objectContaining({ status: 'draft', note: NOTE })]);

    // At rest: ciphertext only.
    const row = await h.ownerKnex('clinical_notes').where({ id: saved.notes[0].id }).first();
    expect(row.content_enc.includes(Buffer.from('sore throat'))).toBe(false);
    expect(row.key_id).toBe('k1');

    expect(expectOk(await consult(patient, appt.id)).notes).toEqual([]);
    expectOk(await api(h, doctor).post(`/appointments/${appt.id}/consultation/note/sign`));
    const forPatient = expectOk(await consult(patient, appt.id));
    expect(forPatient.notes).toEqual([expect.objectContaining({ status: 'signed', version: 1 })]);

    // Signed: no more drafts; corrections need a reason and supersede.
    const again = await api(h, doctor).put(`/appointments/${appt.id}/consultation/note`, NOTE);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('note_already_signed');
    const noteId = forPatient.notes[0].id;
    const noReason = await api(h, doctor).post(`/clinical-notes/${noteId}/corrections`, {
      note: NOTE,
    });
    expect(noReason.status).toBe(400);
    const corrected = expectOk(
      await api(h, doctor).post(`/clinical-notes/${noteId}/corrections`, {
        note: { ...NOTE, plan: 'Synthetic: symptomatic care; review in 3 days.' },
        reason: 'Added review interval',
      }),
      201,
    );
    expect(corrected.notes.map((n) => [n.version, n.status])).toEqual([
      [2, 'signed'],
      [1, 'superseded'],
    ]);
    expect(corrected.notes[0]).toMatchObject({
      supersedesId: noteId,
      correctionReason: 'Added review interval',
    });
    const patientCorrect = await api(h, patient).post(`/clinical-notes/${noteId}/corrections`, {
      note: NOTE,
      reason: 'Patient attempt',
    });
    expect(patientCorrect.status).toBe(403);

    // Database: a signed note cannot change, even through the application role.
    await expect(
      asUser(h, doctor.id, (trx) =>
        trx('clinical_notes').where({ id: corrected.notes[0].id }).update({ key_id: 'k9' }),
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      asUser(h, doctor.id, (trx) => trx('clinical_notes').where({ id: noteId }).del()),
    ).rejects.toThrow(/permission denied|never deleted/);

    const audits = await auditFor(h.knex, {
      resource_type: 'clinical_note',
      patient_id: patient.patient.id,
    });
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'clinical_note.saved',
        'clinical_note.signed',
        'clinical_note.corrected',
      ]),
    );
    // The correction reason is clinical text: never in the audit log.
    expect(JSON.stringify(audits)).not.toContain('Added review interval');
  });
});

describe('prescriptions', () => {
  it('drafts, enforces prescribing rules, signs immutably, renders an integrity-checked PDF', async () => {
    const { doctor, patient, appt } = await liveSetup('rx');
    const prohibited = await api(h, doctor).put(
      `/appointments/${appt.id}/consultation/prescription`,
      {
        items: [
          { drugName: 'Tramadol', dose: '50 mg', frequency: 'twice daily', duration: '5 days' },
        ],
      },
    );
    expect(prohibited.status).toBe(400);
    expect(prohibited.body.code).toBe('validation_failed');

    const draft = expectOk(
      await api(h, doctor).put(`/appointments/${appt.id}/consultation/prescription`, {
        items: ITEMS,
        advice: 'Synthetic: fluids and rest.',
      }),
    );
    expect(draft).toMatchObject({ status: 'draft', version: 1 });
    expect(draft.reference).toMatch(/^RX-[0-9A-Z]{10}$/);
    // The patient never sees drafts.
    expect(expectOk(await consult(patient, appt.id)).prescriptions).toEqual([]);
    expect((await api(h, patient).post(`/prescriptions/${draft.id}/sign`)).status).toBe(403);

    const signed = expectOk(await api(h, doctor).post(`/prescriptions/${draft.id}/sign`));
    expect(signed).toMatchObject({ status: 'signed', pdfReady: false });
    expect(signed.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.items.map((i) => i.drugName)).toEqual(['Paracetamol', 'Warm saline gargle']);

    // Immutable: no new draft, no item or content changes in the database.
    const redo = await api(h, doctor).put(`/appointments/${appt.id}/consultation/prescription`, {
      items: ITEMS,
    });
    expect(redo.body.code).toBe('prescription_already_signed');
    await expect(
      asUser(h, doctor.id, (trx) =>
        trx('prescriptions').where({ id: draft.id }).update({ advice: 'changed' }),
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      asUser(h, doctor.id, (trx) =>
        trx('prescription_items').where({ prescription_id: draft.id }).del(),
      ),
    ).rejects.toThrow(/frozen/);

    // PDF before rendering → 409; worker renders once; idempotent.
    expect((await api(h, patient).post(`/prescriptions/${draft.id}/pdf-url`)).body.code).toBe(
      'pdf_not_ready',
    );
    expect(await h.container.prescriptionService.renderPdf(draft.id)).toMatchObject({
      outcome: 'rendered',
    });
    expect(await h.container.prescriptionService.renderPdf(draft.id)).toEqual({
      outcome: 'exists',
    });
    const url = expectOk(await api(h, patient).post(`/prescriptions/${draft.id}/pdf-url`));
    const pdf = Buffer.from(await (await fetch(url.url)).arrayBuffer());
    expect(pdf.subarray(0, 8).toString('latin1')).toBe('%PDF-1.4');
    expect(pdf.toString('latin1')).toContain('Paracetamol 500 mg');
    expect(pdf.toString('latin1')).toContain(signed.contentSha256);
    const { createHash } = await import('node:crypto');
    expect(createHash('sha256').update(pdf).digest('hex')).toBe(url.sha256);
    // The PDF fields are set once.
    await expect(
      h.knex.transaction(async (trx) => {
        await trx.raw("SELECT set_config('app.system_purpose', 'prescriptions', true)");
        await trx('prescriptions')
          .where({ id: draft.id })
          .update({ pdf_sha256: 'f'.repeat(64) });
      }),
    ).rejects.toThrow(/immutable/);

    // Correction: v2 signed, v1 superseded, same reference; new PDF version.
    const v2 = expectOk(
      await api(h, doctor).post(`/prescriptions/${draft.id}/corrections`, {
        items: [ITEMS[0]],
        advice: 'Synthetic: fluids and rest.',
        reason: 'Removed the gargle',
      }),
      201,
    );
    expect(v2).toMatchObject({ version: 2, status: 'signed', reference: draft.reference });
    expect(v2.supersedesId).toBe(draft.id);
    await h.container.prescriptionService.renderPdf(v2.id);
    const list = expectOk(
      await api(h, patient).get(`/patients/${patient.patient.id}/prescriptions`),
    );
    expect(list.map((p) => [p.version, p.status, p.pdfReady])).toEqual([
      [2, 'signed', true],
      [1, 'superseded', true],
    ]);
    const events = (await outboxOf(h, v2.id)).map((e) => e.event_type);
    expect(events).toContain('prescription.signed');
    expect(templateForEvent('prescription.signed', {})).toBe('prescription_available');

    const audits = await auditFor(h.knex, {
      resource_type: 'prescription',
      patient_id: patient.patient.id,
    });
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'prescription.draft_saved',
        'prescription.signed',
        'prescription.corrected',
        'prescription.downloaded',
      ]),
    );
  });

  it('refuses to render a prescription whose stored content no longer matches its signature', async () => {
    const { doctor, appt } = await liveSetup('rx-tamper');
    const draft = expectOk(
      await api(h, doctor).put(`/appointments/${appt.id}/consultation/prescription`, {
        items: [ITEMS[0]],
      }),
    );
    expectOk(await api(h, doctor).post(`/prescriptions/${draft.id}/sign`));
    await h.ownerKnex.transaction(async (trx) => {
      await trx.raw('ALTER TABLE prescription_items DISABLE TRIGGER prescription_items_frozen');
      await trx('prescription_items')
        .where({ prescription_id: draft.id })
        .update({ dose: '10 tablets' });
      await trx.raw('ALTER TABLE prescription_items ENABLE TRIGGER prescription_items_frozen');
    });
    await expect(h.container.prescriptionService.renderPdf(draft.id)).rejects.toThrow(/integrity/);
    const row = await h.ownerKnex('prescriptions').where({ id: draft.id }).first();
    expect(row.pdf_object_key).toBeNull();
  });

  it('other doctors read signed prescriptions only with a consent covering prescriptions', async () => {
    const { doctor, patient, appt } = await liveSetup('rx-share');
    const draft = expectOk(
      await api(h, doctor).put(`/appointments/${appt.id}/consultation/prescription`, {
        items: [ITEMS[0]],
      }),
    );
    expectOk(await api(h, doctor).post(`/prescriptions/${draft.id}/sign`));
    const second = await atRealTime(() => createVerifiedDoctor(h, admin, 'rx-share-second'));
    await linkCare(h, patient, second);
    const path = `/patients/${patient.patient.id}/prescriptions`;

    const without = await api(h, second).get(path);
    expect(without.status).toBe(403);
    expect(without.body.code).toBe('consent_required');
    expect((await api(h, second).get(`/prescriptions/${draft.id}`)).status).toBe(404);

    const labOnly = expectOk(
      await grant(h, patient, {
        patientId: patient.patient.id,
        doctorId: second.doctor.id,
        documentTypes: ['lab_report'],
      }),
      201,
    );
    expect((await api(h, second).get(path)).status).toBe(403);
    expectOk(await api(h, patient).post(`/consents/${labOnly.id}/revoke`, { reasonCode: 'other' }));
    expectOk(
      await grant(h, patient, {
        patientId: patient.patient.id,
        doctorId: second.doctor.id,
        documentTypes: ['prescription'],
      }),
      201,
    );
    const shared = expectOk(await api(h, second).get(path));
    expect(shared).toEqual([expect.objectContaining({ id: draft.id, status: 'signed' })]);
    // Notes stay with the author and the patient side.
    const notes = await asUser(h, second.id, (trx) =>
      trx('clinical_notes').where({ patient_id: patient.patient.id }),
    );
    expect(notes).toEqual([]);
    expect((await atRealTime(() => api(h, admin).get(path))).status).toBe(403);
    const audits = await auditFor(h.knex, {
      action: 'prescription.list_viewed',
      patient_id: patient.patient.id,
    });
    expect(audits).toHaveLength(1);
  });
});

describe('outcomes', () => {
  it('A: needs a signed note, cancels unsigned drafts, completes the appointment', async () => {
    const { doctor, patient, appt } = await liveSetup('out-a');
    const path = `/appointments/${appt.id}/consultation/outcome`;
    const early = await api(h, doctor).post(path, { outcome: 'online_managed' });
    expect(early.body.code).toBe('note_required');
    expect((await api(h, patient).post(path, { outcome: 'online_managed' })).status).toBe(403);

    await api(h, doctor).put(`/appointments/${appt.id}/consultation/note`, NOTE);
    await api(h, doctor).post(`/appointments/${appt.id}/consultation/note/sign`);
    const draft = expectOk(
      await api(h, doctor).put(`/appointments/${appt.id}/consultation/prescription`, {
        items: [ITEMS[0]],
      }),
    );
    const done = expectOk(
      await api(h, doctor).post(path, { outcome: 'online_managed', followUpOn: '2026-12-01' }),
    );
    expect(done.consultation).toMatchObject({
      status: 'ended',
      outcome: 'online_managed',
      outcomeDetail: { followUpOn: '2026-12-01' },
    });
    expect(done.appointment.status).toBe('completed');
    const cancelled = await h.ownerKnex('prescriptions').where({ id: draft.id }).first();
    expect(cancelled.status).toBe('cancelled');
    // Once recorded, the outcome is final.
    expect((await api(h, doctor).post(path, { outcome: 'online_managed' })).body.code).toBe(
      'consultation_ended',
    );
    const events = await outboxOf(h, done.consultation.id);
    expect(events.map((e) => e.event_type)).toEqual(['consultation.completed']);
    expect(events[0].payload).toMatchObject({
      outcome: 'online_managed',
      followUpOn: '2026-12-01',
    });
    expect(templateForEvent('consultation.completed', events[0].payload)).toBeNull();

    // Timeline: the outcome and nothing of the note.
    await h.container.timelineProjector.handleEvent({
      eventType: 'consultation.completed',
      aggregateType: 'consultation',
      aggregateId: done.consultation.id,
    });
    const timeline = expectOk(
      await api(h, patient).get(`/patients/${patient.patient.id}/timeline`),
    );
    const event = timeline.find((e) => e.type === 'consultation');
    expect(event).toMatchObject({
      title: 'Consultation: managed online',
      provenance: 'doctor_reported',
    });
    expect(JSON.stringify(event)).not.toContain('pharyngitis');
  });

  it('B: asks the patient to book an in-person visit', async () => {
    const { doctor, patient, appt } = await liveSetup('out-b');
    await api(h, doctor).put(`/appointments/${appt.id}/consultation/note`, NOTE);
    await api(h, doctor).post(`/appointments/${appt.id}/consultation/note/sign`);
    const done = expectOk(
      await api(h, doctor).post(`/appointments/${appt.id}/consultation/outcome`, {
        outcome: 'physical_visit_required',
        visitNote: 'Synthetic: throat examination needed.',
      }),
    );
    expect(done.consultation.outcomeDetail.visitNote).toContain('throat');
    const [event] = await outboxOf(h, done.consultation.id);
    const sent = await h.container.notificationService.handleEvent({
      eventId: event.id,
      eventType: event.event_type,
      aggregateId: event.aggregate_id,
      payload: event.payload,
    });
    expect(sent).toMatchObject({ outcome: 'sent', template: 'in_person_visit_requested' });
    const mail = h.notificationProvider.sent.find(
      (m) => m.template === 'in_person_visit_requested' && m.to === patient.email,
    );
    expect(mail.text).not.toContain('throat');
  });

  it('C: emergency escalation is recorded at once, flagged, and shows fixed guidance', async () => {
    const { doctor, patient, appt } = await liveSetup('out-c');
    const done = expectOk(
      await api(h, doctor).post(`/appointments/${appt.id}/consultation/outcome`, {
        outcome: 'emergency_escalation',
        confirm: true,
      }),
    );
    expect(done.consultation.outcome).toBe('emergency_escalation');
    const status = expectOk(await consult(patient, appt.id, '/status'));
    expect(status.emergencyGuidance.lines.join(' ')).toContain('112');
    const [audit] = await auditFor(h.knex, {
      action: 'consultation.emergency_escalated',
      patient_id: patient.patient.id,
    });
    expect(audit.metadata).toMatchObject({ flagged: true });
    expect(templateForEvent('consultation.completed', { outcome: 'emergency_escalation' })).toBe(
      'emergency_guidance',
    );
  });

  it('in-clinic consultations start after check-in and have no video', async () => {
    const { doctor, appt } = await liveSetup('clinic', { start: false, mode: 'in_clinic' });
    const before = await api(h, doctor).post(`/appointments/${appt.id}/consultation/start`);
    expect(before.body.code).toBe('appointment_time_rule');
    // The clinic desk checks the patient in (scheduling runs on the real clock).
    await h
      .ownerKnex('appointments')
      .where({ id: appt.id })
      .update({ status: 'checked_in', checked_in_at: clock() });
    const started = expectOk(
      await api(h, doctor).post(`/appointments/${appt.id}/consultation/start`),
    );
    expect(started.consultation).toMatchObject({ mode: 'in_clinic', video: false });
    const join = await api(h, doctor).post(`/appointments/${appt.id}/consultation/join`);
    expect(join.body.code).toBe('consultation_not_live');
  });
});
