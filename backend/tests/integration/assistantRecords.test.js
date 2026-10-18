import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInputDigester } from '../../src/core/crypto/inputDigest.js';
import { auditFor, createHarness } from './harness.js';
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
let recordAnswer = () => {
  throw new Error('no record answer');
};
const questions = [];
let healthAnswer = () => ({ matched: false });
const healthCalls = [];
const ai = {
  async agentStep(input) {
    calls.push(structuredClone(input));
    return script(input);
  },
  async askRecord(input) {
    questions.push(structuredClone(input));
    return recordAnswer(input);
  },
  async healthInfo(input) {
    healthCalls.push(structuredClone(input));
    return healthAnswer(input);
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

describe('assistant answers questions about the person’s documents (Part 4)', () => {
  const ASK = classify('ask_records', {
    kind: 'not_yet',
    message: 'Your documents are in Health Records.',
    cards: [{ type: 'link', target: 'records' }],
  });

  it('answers with sources from the record when AI reading is on; nothing is stored', async () => {
    const patient = await createPatient(h, 'askrec');
    expectOk(
      await api(h, patient).put(`/patients/${patient.patient.id}/ai-processing`, { enabled: true }),
    );
    const s = expectOk(await session(patient), 201);
    script = ASK;
    recordAnswer = () => ({
      status: 'answered',
      answer: 'HbA1c was 6.1 %.',
      sentences: [{ text: 'HbA1c was 6.1 %.', citations: [] }],
    });
    const turn = expectOk(await say(patient, s, 'what was my last HbA1c secretword', 1));
    expect(turn.reply.kind).toBe('answer');
    expect(turn.reply.cards[0]).toEqual({
      type: 'record_answer',
      source: 'ai_generated',
      sentences: [{ text: 'HbA1c was 6.1 %.', citations: [] }],
    });
    expect(turn.reply.cards[1]).toEqual({ type: 'link', target: 'records' });
    // The record question gets the person's question; the AI step never the record.
    expect(questions.at(-1).question).toBe('what was my last HbA1c secretword');
    expect(JSON.stringify(calls.at(-1))).not.toContain('HbA1c was 6.1');
    const rows = await auditFor(h.knex, { resource_id: s.id, action: 'assistant.turn' });
    expect(JSON.stringify(rows)).not.toMatch(/secretword|HbA1c was/);
    const stored = await h.ownerKnex('agent_sessions').where({ id: s.id }).first();
    expect(JSON.stringify(stored)).not.toMatch(/secretword|HbA1c was/);
  });

  it('points to Privacy & Access when AI reading is off, and degrades quietly on errors', async () => {
    const patient = await createPatient(h, 'askrec-off');
    const s = expectOk(await session(patient), 201);
    script = ASK;
    const before = questions.length;
    const off = expectOk(await say(patient, s, 'what did my echo show', 1));
    expect(off.reply.cards.map((c) => c.target)).toEqual(['privacy', 'records']);
    expect(questions.length).toBe(before); // never reached the AI service

    expectOk(
      await api(h, patient).put(`/patients/${patient.patient.id}/ai-processing`, { enabled: true }),
    );
    recordAnswer = () => {
      throw new Error('AI service down');
    };
    const down = expectOk(await say(patient, s, 'what did my echo show', off.session.version));
    expect(down.reply.message).toBe('Your documents are in Health Records.');
    expect(down.reply.cards.some((c) => c.type === 'record_answer')).toBe(false);
  });
});

describe('general health information for a described concern (ADR-0040)', () => {
  const ARTICLE = {
    id: 'acidity',
    title: 'Acidity and heartburn',
    overview: 'Acidity, or heartburn, is a burning feeling in the chest or upper stomach.',
    linkedWith: ['Large meals, or eating late at night'],
    mayHelp: ['Eat smaller meals more often, and don’t skip meals'],
    seeDoctorIf: ['Remedies from a pharmacy haven’t helped'],
    urgentIf: ['You vomit blood, or vomit that looks like coffee grounds'],
    review: { status: 'draft', reviewedBy: null, reviewedOn: null },
  };
  const INFO = {
    matched: true,
    runId: randomUUID(),
    status: 'answered',
    article: ARTICLE,
    summary: [
      {
        text: 'Large meals, or eating late at night.',
        citations: [{ label: 'L2', section: 'often linked with' }],
      },
    ],
  };
  const FIND = classify('find_doctor', {
    kind: 'answer',
    message: 'A general physician is a good first step.',
    cards: [],
  });

  it('shows the library article and its summary before the doctors; nothing is stored', async () => {
    const patient = await createPatient(h, 'hinfo');
    const s = expectOk(await session(patient), 201);
    script = FIND;
    healthAnswer = () => INFO;
    const text = 'I am having acidity for past 3 days secretword';
    const turn = expectOk(await say(patient, s, text, 1));
    expect(turn.reply.message).toBe(
      "Here's some general information about acidity and heartburn. A general physician is a good first step.",
    );
    expect(turn.reply.cards[0]).toEqual({
      type: 'health_info',
      source: 'health_library',
      title: ARTICLE.title,
      overview: ARTICLE.overview,
      linkedWith: ARTICLE.linkedWith,
      mayHelp: ARTICLE.mayHelp,
      seeDoctorIf: ARTICLE.seeDoctorIf,
      urgentIf: ARTICLE.urgentIf,
      review: ARTICLE.review,
      summary: INFO.summary,
    });
    const asked = healthCalls.at(-1);
    expect(asked.message).toBe(text);
    expect(asked.inputDigest).toEqual(
      createInputDigester(h.config.aiInputDigest).digest('health_info_message', text),
    );
    const rows = await auditFor(h.knex, { resource_id: s.id, action: 'assistant.turn' });
    expect(JSON.stringify(rows)).not.toMatch(/secretword|acidity|Acidity/);
    const stored = await h.ownerKnex('agent_sessions').where({ id: s.id }).first();
    expect(JSON.stringify(stored)).not.toMatch(/secretword|Acidity and heartburn/);
  });

  it('only on doctor searches from the person’s words; drops anything malformed', async () => {
    const patient = await createPatient(h, 'hinfo2');
    const s = expectOk(await session(patient), 201);
    healthAnswer = () => INFO;
    const before = healthCalls.length;
    script = classify('view_medications', {
      kind: 'not_yet',
      message: 'Prescriptions.',
      cards: [],
    });
    const other = expectOk(await say(patient, s, 'my medicines for acidity', 1));
    expect(other.reply.cards.some((c) => c.type === 'health_info')).toBe(false);
    expect(healthCalls.length).toBe(before);

    script = FIND;
    healthAnswer = () => ({ ...INFO, article: { ...ARTICLE, urgentIf: 'not a list' } });
    const bad = expectOk(await say(patient, s, 'acidity again', other.session.version));
    expect(bad.reply.cards.some((c) => c.type === 'health_info')).toBe(false);
    expect(bad.reply.message).toBe('A general physician is a good first step.');

    healthAnswer = () => {
      throw new Error('AI service down');
    };
    const down = expectOk(await say(patient, s, 'acidity again', bad.session.version));
    expect(down.degraded).toBe(false);
    expect(down.reply.cards.some((c) => c.type === 'health_info')).toBe(false);

    healthAnswer = () => ({ matched: false });
    const none = expectOk(await say(patient, s, 'a dermatologist in Pune', down.session.version));
    expect(none.reply.cards).toEqual([]);
  });
});
