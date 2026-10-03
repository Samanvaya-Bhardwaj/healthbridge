import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { auditFor, createHarness } from './harness.js';
import {
  api,
  createPatient,
  createPlatformAdmin,
  createVerifiedDoctor,
  expectOk,
  linkCare,
} from './m2fixtures.js';
import { outboxOf } from './m4fixtures.js';
import { asUser } from './m5fixtures.js';
import { stubAiClient } from './m6fixtures.js';
import { templateForEvent } from '../../src/modules/notifications/notificationService.js';

let offsetMs = 0;
const clock = () => new Date(Date.now() + offsetMs);
let h;
let admin;
const ai = stubAiClient(() => h);
beforeAll(async () => {
  h = await createHarness({ now: clock, aiClient: ai });
  admin = await createPlatformAdmin(h);
});
afterAll(async () => {
  await h.close();
});

const todayIst = () => DateTime.now().setZone('Asia/Kolkata').toISODate();
const plusDays = (n) => DateTime.now().setZone('Asia/Kolkata').plus({ days: n }).toISODate();

async function setup(label) {
  offsetMs = 0;
  const doctor = await createVerifiedDoctor(h, admin, `${label}-doc`);
  const patient = await createPatient(h, `${label}-pt`);
  await linkCare(h, patient, doctor);
  return { doctor, patient };
}

/** Delivers the follow-up's outbox events of one type to the notification consumer. */
async function deliver(followUpId, eventType) {
  const events = (await outboxOf(h, followUpId)).filter((e) => e.event_type === eventType);
  const results = [];
  for (const e of events) {
    results.push(
      await h.container.notificationService.handleEvent({
        eventId: e.id,
        eventType: e.event_type,
        aggregateId: e.aggregate_id,
        payload: e.payload,
      }),
    );
  }
  return results;
}

const schedule = (doctor, patient, dueOn = todayIst()) =>
  api(h, doctor).post(`/patients/${patient.patient.id}/follow-ups`, { dueOn });

describe('scheduling follow-ups', () => {
  it('only the treating doctor schedules; dates cannot be in the past', async () => {
    const { doctor, patient } = await setup('fu-create');
    const stranger = await createVerifiedDoctor(h, admin, 'fu-stranger');
    const created = expectOk(await schedule(doctor, patient, plusDays(3)), 201);
    expect(created).toMatchObject({ status: 'scheduled', origin: 'doctor', dueOn: plusDays(3) });
    expect((await schedule(stranger, patient)).status).toBe(404);
    expect((await schedule(patient, patient)).status).toBe(403);
    const past = await schedule(doctor, patient, plusDays(-1));
    expect(past.body.code).toBe('due_in_past');
    expect((await outboxOf(h, created.id)).map((e) => e.event_type)).toEqual(['follow_up.created']);

    const mine = expectOk(await api(h, doctor).get('/doctors/me/follow-ups?status=open'));
    expect(mine.map((f) => f.id)).toEqual([created.id]);
    expect(expectOk(await api(h, stranger).get('/doctors/me/follow-ups'))).toEqual([]);
    const forPatient = expectOk(
      await api(h, patient).get(`/patients/${patient.patient.id}/follow-ups`),
    );
    expect(forPatient).toEqual([
      expect.objectContaining({ id: created.id, doctorName: expect.any(String) }),
    ]);
    expect((await api(h, stranger).get(`/follow-ups/${created.id}`)).status).toBe(404);
  });

  it('creates one follow-up from a consultation outcome with a date (idempotent)', async () => {
    const { doctor, patient } = await setup('fu-outcome');
    // A completed consultation as the M9 flow leaves it (owner insert: time-independent).
    const consultation = await h.ownerKnex.transaction(async (trx) => {
      const apptId = randomUUID();
      const care = await trx('care_relationships')
        .where({ patient_id: patient.patient.id, doctor_id: doctor.doctor.id })
        .first('id');
      await trx('appointments').insert({
        id: apptId,
        care_relationship_id: care.id,
        patient_id: patient.patient.id,
        doctor_id: doctor.doctor.id,
        mode: 'online',
        status: 'completed',
        starts_at: new Date(Date.now() - 3_600_000),
        ends_at: new Date(Date.now() - 2_700_000),
        fee_paise: 0,
        currency: 'INR',
        booked_by_user_id: patient.id,
        idempotency_key: randomUUID(),
        confirmed_at: new Date(Date.now() - 86_400_000),
        completed_at: new Date(),
      });
      const id = randomUUID();
      await trx('consultations').insert({
        id,
        appointment_id: apptId,
        patient_id: patient.patient.id,
        doctor_id: doctor.doctor.id,
        doctor_user_id: doctor.id,
        mode: 'online',
        status: 'ended',
        video_provider: 'mock',
        video_room_ref: `hb-${randomUUID().slice(0, 16)}`,
        started_at: new Date(Date.now() - 3_600_000),
        ended_at: new Date(),
        outcome: 'online_managed',
        outcome_detail: JSON.stringify({ followUpOn: plusDays(7) }),
        outcome_recorded_at: new Date(),
      });
      return id;
    });
    const event = {
      eventType: 'consultation.completed',
      aggregateId: consultation,
      payload: { outcome: 'online_managed', followUpOn: plusDays(7) },
    };
    const first = await h.container.followUpService.handleEvent(event);
    expect(first.outcome).toBe('created');
    expect((await h.container.followUpService.handleEvent(event)).outcome).toBe('duplicate');
    const rows = await h.ownerKnex('follow_ups').where({ consultation_id: consultation });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ origin: 'consultation_outcome', doctor_user_id: doctor.id });
    // Other outcomes or no date: nothing.
    expect(
      (
        await h.container.followUpService.handleEvent({
          ...event,
          payload: { outcome: 'emergency_escalation' },
        })
      ).outcome,
    ).toBe('none');
  });
});

describe('check-ins', () => {
  it('opens when due, reminds (inbox + email), and escalates red flags to urgent', async () => {
    const { doctor, patient } = await setup('fu-urgent');
    expectOk(
      await api(h, patient).put(`/patients/${patient.patient.id}/ai-processing`, { enabled: true }),
    );
    const f = expectOk(await schedule(doctor, patient), 201);
    const swept = await h.container.followUpService.sweep();
    expect(swept.opened).toBeGreaterThanOrEqual(1);
    const [reminder] = await deliver(f.id, 'follow_up.reminder_due');
    expect(reminder).toMatchObject({ outcome: 'sent', template: 'follow_up_due' });
    const mail = h.notificationProvider.sent.find(
      (m) => m.template === 'follow_up_due' && m.to === patient.email,
    );
    expect(mail).toBeTruthy();

    // Inbox: own entries only, unread count, mark read.
    const inbox = await api(h, patient).get('/notifications');
    expect(inbox.status).toBe(200);
    expect(inbox.body.meta.unreadCount).toBe(1);
    const [entry] = inbox.body.data;
    expect(entry).toMatchObject({
      template: 'follow_up_due',
      link: '/app/follow-ups',
      priority: 'normal',
    });
    expect((await api(h, doctor).post(`/notifications/${entry.id}/read`)).status).toBe(404);
    expectOk(await api(h, patient).post(`/notifications/${entry.id}/read`));
    expect(expectOk(await api(h, patient).get('/notifications/unread-count')).unreadCount).toBe(0);
    await expect(
      asUser(h, patient.id, (trx) =>
        trx('inbox_notifications').where({ id: entry.id }).update({ title: 'x' }),
      ),
    ).rejects.toThrow(/only the read time/);

    // The patient answers with a warning sign → urgent + fixed guidance.
    const answer = expectOk(
      await api(h, patient).post(`/follow-ups/${f.id}/responses`, {
        overall: 'worse',
        redFlags: ['breathing_difficulty'],
        note: 'Synthetic: cough worse at night.',
      }),
      201,
    );
    expect(answer.status).toBe('urgent');
    expect(answer.escalation).toEqual({
      level: 'urgent',
      reasons: ['red_flag:breathing_difficulty'],
    });
    expect(answer.emergencyGuidance.lines.join(' ')).toContain('112');
    expect(answer.summary).toBeNull();
    const again = await api(h, patient).post(`/follow-ups/${f.id}/responses`, {
      overall: 'better',
    });
    expect(again.body.code).toBe('follow_up_not_open');

    // Encrypted at rest; audit holds counts only.
    const stored = await h.ownerKnex('follow_up_responses').where({ follow_up_id: f.id }).first();
    expect(stored.note_enc.includes(Buffer.from('cough'))).toBe(false);
    const [audit] = await auditFor(h.knex, { action: 'follow_up.responded', resource_id: f.id });
    expect(audit.metadata).toEqual({ redFlags: 1, hasNote: true });
    expect(JSON.stringify(audit)).not.toContain('breathing');

    // The doctor is alerted (urgent inbox + email); the AI summary is written.
    const [alert] = await deliver(f.id, 'follow_up.responded');
    expect(alert).toMatchObject({ outcome: 'sent', template: 'follow_up_urgent' });
    const doctorInbox = (await api(h, doctor).get('/notifications')).body.data;
    expect(doctorInbox[0]).toMatchObject({ template: 'follow_up_urgent', priority: 'urgent' });
    expect(doctorInbox[0].body).not.toMatch(/breath|cough/i);
    expect(
      (
        await h.container.followUpService.handleEvent({
          eventType: 'follow_up.responded',
          payload: { followUpId: f.id },
        })
      ).outcome,
    ).toBe('summarized');

    const forDoctor = expectOk(await api(h, doctor).get(`/follow-ups/${f.id}`));
    expect(forDoctor.response).toMatchObject({
      overall: 'worse',
      note: 'Synthetic: cough worse at night.',
      redFlags: [{ code: 'breathing_difficulty', label: 'Difficulty breathing' }],
    });
    expect(forDoctor.summary).toMatchObject({ status: 'ready', source: 'ai_generated' });
    expect(forDoctor.summary.sentences[0].text).toContain('worse');
    const forPatient = expectOk(await api(h, patient).get(`/follow-ups/${f.id}`));
    expect(forPatient.summary).toBeNull();
    expect(forPatient.emergencyGuidance).not.toBeNull();
  });

  it('worse → needs attention; better → no alert; no AI summary without opt-in', async () => {
    const { doctor, patient } = await setup('fu-levels');
    const worse = expectOk(await schedule(doctor, patient), 201);
    const better = expectOk(await schedule(doctor, patient), 201);
    await h.container.followUpService.sweep();
    expect(
      expectOk(
        await api(h, patient).post(`/follow-ups/${worse.id}/responses`, { overall: 'worse' }),
        201,
      ).status,
    ).toBe('needs_attention');
    expect(
      expectOk(
        await api(h, patient).post(`/follow-ups/${better.id}/responses`, { overall: 'better' }),
        201,
      ).status,
    ).toBe('responded');
    expect(templateForEvent('follow_up.responded', { level: 'none' })).toBeNull();
    const [attention] = await deliver(worse.id, 'follow_up.responded');
    expect(attention.template).toBe('follow_up_attention');
    expect((await h.container.followUpService.summarize(worse.id)).outcome).toBe(
      'ai_processing_disabled',
    );
  });

  it('reminds at most twice, then alerts the doctor when nobody answers', async () => {
    const { doctor, patient } = await setup('fu-silent');
    const f = expectOk(await schedule(doctor, patient), 201);
    const sweepAt = async (hours) => {
      offsetMs = hours * 3_600_000;
      try {
        return await h.container.followUpService.sweep();
      } finally {
        offsetMs = 0;
      }
    };
    await sweepAt(0);
    await sweepAt(1); // too soon for a second reminder
    await sweepAt(49);
    await sweepAt(100); // max reached
    await sweepAt(24 * 8);
    const row = await h.ownerKnex('follow_ups').where({ id: f.id }).first();
    expect(row).toMatchObject({
      status: 'needs_attention',
      reminder_count: 2,
      escalation_level: 'attention',
    });
    expect(row.escalation_reasons).toEqual(['no_response']);
    const types = (await outboxOf(h, f.id)).map((e) => e.event_type);
    expect(types.filter((t) => t === 'follow_up.reminder_due')).toHaveLength(2);
    expect(types).toContain('follow_up.no_response');
    const [alert] = await deliver(f.id, 'follow_up.no_response');
    expect(alert.template).toBe('follow_up_attention');
    // Escalated for silence: the check-in is now with the doctor.
    const late = await api(h, patient).post(`/follow-ups/${f.id}/responses`, { overall: 'better' });
    expect(late.body.code).toBe('follow_up_not_open');
  });

  it('the doctor closes; the patient side cannot change anything but its answer', async () => {
    const { doctor, patient } = await setup('fu-close');
    const f = expectOk(await schedule(doctor, patient, plusDays(5)), 201);
    await expect(
      asUser(h, patient.id, (trx) =>
        trx('follow_ups')
          .where({ id: f.id })
          .update({ status: 'responded', due_on: plusDays(30) }),
      ),
    ).rejects.toThrow(/only answer/);
    expect((await api(h, patient).post(`/follow-ups/${f.id}/close`, {})).status).toBe(403);
    const closed = expectOk(
      await api(h, doctor).post(`/follow-ups/${f.id}/close`, { note: 'Not needed' }),
    );
    expect(closed.status).toBe('cancelled');
    expect((await api(h, doctor).post(`/follow-ups/${f.id}/close`, {})).body.code).toBe(
      'follow_up_closed',
    );
    const answer = await api(h, patient).post(`/follow-ups/${f.id}/responses`, { overall: 'same' });
    expect(answer.body.code).toBe('follow_up_not_open');

    await h.container.timelineProjector.handleEvent({
      eventType: 'follow_up.closed',
      aggregateType: 'follow_up',
      aggregateId: f.id,
    });
    const event = await h.ownerKnex('medical_events').where({ source_id: f.id }).first();
    expect(event).toMatchObject({ event_type: 'follow_up', status: 'cancelled', hidden: true });
  });
});
