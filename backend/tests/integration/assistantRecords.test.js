import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness } from './harness.js';
import {
  api,
  createPatient,
  createPlatformAdmin,
  createVerifiedDoctor,
  expectOk,
  linkCare,
} from './m2fixtures.js';
import { bookSlot, publishPaidWeek } from './m4fixtures.js';

/**
 * Step 10: the assistant answers "my appointments" and "my medicines" with facts from the
 * record. The AI only chooses the intent; the backend reads the facts through the same
 * services and access checks as the pages, after the AI step, and never sends them to it.
 */
let offsetMs = 0;
const clock = () => new Date(Date.now() + offsetMs);

let script = () => {
  throw new Error('no script');
};
const calls = [];
const ai = {
  async agentStep(input) {
    calls.push(structuredClone(input));
    return script(input);
  },
};

let h;
let admin;
beforeAll(async () => {
  h = await createHarness({ now: clock, aiClient: ai });
  admin = await createPlatformAdmin(h);
});
afterAll(async () => {
  await h.close();
});

const ITEMS = [
  {
    drugName: 'Cetirizine',
    strength: '10 mg',
    form: 'tablet',
    dose: '1 tablet',
    frequency: 'once daily',
    route: 'oral',
    duration: '5 days',
    instructions: 'At night.',
  },
];

/** A patient with two upcoming appointments and a signed prescription from the first. */
async function patientWithRecords(label) {
  offsetMs = 0;
  const doctor = await createVerifiedDoctor(h, admin, `${label}-doc`);
  await publishPaidWeek(h, doctor, { feePaise: 0, mode: 'online' });
  const patient = await createPatient(h, `${label}-pt`);
  await linkCare(h, patient, doctor);
  const first = await bookSlot(h, patient, doctor, { index: 0, days: 2 });
  const second = await bookSlot(h, patient, doctor, { index: 1, days: 3 });
  offsetMs = new Date(first.startsAt).getTime() - 5 * 60_000 - Date.now();
  expectOk(await api(h, doctor).post(`/appointments/${first.id}/consultation/start`));
  const draft = expectOk(
    await api(h, doctor).put(`/appointments/${first.id}/consultation/prescription`, {
      items: ITEMS,
    }),
  );
  expectOk(await api(h, doctor).post(`/prescriptions/${draft.id}/sign`));
  offsetMs = 0;
  return { doctor, patient, appointments: [first, second], prescriptionId: draft.id };
}

/** Plays a planner that only classifies: one respond step with the given intent. */
function classify(intent, reply) {
  return (input) => ({
    state: { ...input.state, intent },
    action: { type: 'respond' },
    reply,
    run: { runId: randomUUID() },
  });
}

const session = (who) => api(h, who).post('/assistant/sessions', {});
const say = (who, s, text, version) =>
  api(h, who).post(`/assistant/sessions/${s.id}/messages`, {
    text,
    version,
    timeZone: 'Asia/Kolkata',
  });

describe('assistant answers from the record (step 10)', () => {
  it('shows upcoming appointments and recent signed medicines, never sending them to the AI', async () => {
    const { patient, doctor, appointments, prescriptionId } = await patientWithRecords('rec1');
    const s = expectOk(await session(patient), 201);
    calls.length = 0;

    script = classify('reschedule', {
      kind: 'not_yet',
      message: "I can't change appointments here yet.",
      cards: [{ type: 'link', target: 'appointments' }],
    });
    const a = expectOk(await say(patient, s, 'I need to reschedule', 1));
    const shown = a.reply.cards.filter((c) => c.type === 'appointment');
    expect(shown.map((c) => c.appointmentId).sort()).toEqual(appointments.map((x) => x.id).sort());
    expect(shown[0]).toMatchObject({
      source: 'record',
      doctorName: doctor.doctor.professionalName,
      mode: 'online',
    });
    expect(Object.keys(shown[0]).sort()).toEqual(
      [
        'appointmentId',
        'doctorName',
        'mode',
        'reference',
        'source',
        'startsAt',
        'status',
        'type',
      ].sort(),
    );
    expect(a.reply.cards.some((c) => c.type === 'link' && c.target === 'appointments')).toBe(true);

    script = classify('view_medications', {
      kind: 'not_yet',
      message: 'Signed prescriptions are on the Prescriptions page.',
      cards: [{ type: 'link', target: 'prescriptions' }],
    });
    const m = expectOk(await say(patient, s, 'What medicines do I take?', a.session.version));
    const medicines = m.reply.cards.filter((c) => c.type === 'medication');
    expect(medicines).toHaveLength(1);
    expect(medicines[0]).toMatchObject({
      source: 'record',
      prescriptionId,
      items: [{ drugName: 'Cetirizine', dose: '1 tablet', frequency: 'once daily' }],
    });

    // The AI saw neither the appointments nor the medicines.
    const sent = JSON.stringify(calls);
    expect(sent).not.toContain('Cetirizine');
    for (const x of appointments) expect(sent).not.toContain(x.id);
    // The audit row counts cards; it holds no medicine or appointment detail.
    const turns = await h
      .ownerKnex('audit.audit_logs')
      .where({ action: 'assistant.turn', resource_id: s.id })
      .orderBy('occurred_at');
    expect(turns.map((t) => t.metadata.cards)).toEqual([3, 2]);
    expect(JSON.stringify(turns)).not.toContain('Cetirizine');
  });

  it('adds nothing when the AI step fails, or for other intents', async () => {
    const { patient } = await patientWithRecords('rec2');
    const s = expectOk(await session(patient), 201);
    script = () => {
      throw new Error('AI service down');
    };
    const down = expectOk(await say(patient, s, 'show my appointments', 1));
    expect(down.degraded).toBe(true);
    expect(down.reply.cards.some((c) => c.type === 'appointment')).toBe(false);

    script = classify('greeting', { kind: 'help', message: 'Hello!', cards: [] });
    const hello = expectOk(await say(patient, s, 'hello', down.session.version));
    expect(hello.reply.cards).toEqual([]);
  });

  it('shows another patient nothing: the facts come from the session patient only', async () => {
    const { patient } = await patientWithRecords('rec3');
    const other = await createPatient(h, 'rec3-other');
    const s = expectOk(await session(other), 201);
    script = classify('view_medications', {
      kind: 'not_yet',
      message: 'Signed prescriptions are on the Prescriptions page.',
      cards: [{ type: 'link', target: 'prescriptions' }],
    });
    const turn = expectOk(await say(other, s, 'my medicines', 1));
    expect(turn.reply.cards.filter((c) => c.type === 'medication')).toEqual([]);
    expect(patient.patient.id).not.toBe(other.patient.id);
  });
});
