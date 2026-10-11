import { createHash, createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ASSISTANT_EMERGENCY_MESSAGE } from '@healthbridge/shared';
import { withActor, withSystem } from '../../src/core/db/actorContext.js';
import { deriveMessageDigestKey } from '../../src/modules/assistant/service.js';
import request from 'supertest';
import { auditFor, authHeader, createHarness, createUser } from './harness.js';
import {
  api,
  createPatient,
  createPlatformAdmin,
  createVerifiedDoctor,
  expectOk,
  linkCare,
  profileInput,
} from './m2fixtures.js';

/**
 * M13.1 care assistant: the backend owns the turn loop. The AI step is scripted here so the
 * tests can play a faithful planner, a manipulated one, a broken one or an absent one; the
 * real graph is covered by the AI service's own tests.
 */
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
  h = await createHarness({ aiClient: ai });
  admin = await createPlatformAdmin(h);
});
afterAll(async () => {
  await h.close();
});

const respond = (state, reply) => ({ state, action: { type: 'respond' }, reply, run: {} });
const toolCall = (state, tool, args = {}) => ({
  state,
  action: { type: 'tool', tool, args },
  reply: null,
  run: { runId: randomUUID() },
});

/** A faithful planner: care team → search → reply with the candidates. */
function planner({ specialty = 'General Medicine' } = {}) {
  return (input) => {
    const state = input.state;
    if (input.message) return toolCall(state, 'getPatientCareTeam');
    if (input.toolResult.name === 'getPatientCareTeam') {
      return toolCall(
        {
          ...state,
          intent: 'find_doctor',
          criteria: { ...state.criteria, specialty },
          careTeamDoctorIds: input.toolResult.data.doctors.map((d) => d.doctorId),
        },
        'searchDoctors',
        { specialty },
      );
    }
    const ids = input.toolResult.data.doctors.map((d) => d.doctorId).slice(0, 5);
    return respond(
      { ...state, candidateDoctorIds: ids },
      {
        kind: 'answer',
        message: 'Here are verified doctors who match.',
        cards: ids.map((doctorId) => ({ type: 'doctor', doctorId })),
      },
    );
  };
}

const session = (who, body = {}) => api(h, who).post('/assistant/sessions', body);
const say = (who, s, text, version = s.version) =>
  api(h, who).post(`/assistant/sessions/${s.id}/messages`, {
    text,
    version,
    timeZone: 'Asia/Kolkata',
  });

describe('assistant sessions and the turn loop', () => {
  it('runs backend tools for the planner and shows only backend data, never storing the message', async () => {
    const patient = await createPatient(h, 'asst-p1');
    const doctor = await createVerifiedDoctor(h, admin, 'asst-d1');
    await linkCare(h, patient, doctor);
    script = planner();
    calls.length = 0;
    const s = expectOk(await session(patient), 201);
    expect(s).toMatchObject({ actingFor: 'self', status: 'active', version: 1, turns: 0 });

    const secret = 'my recurring skin irritation since July';
    const turn = expectOk(await say(patient, s, `I need a general physician, ${secret}`));
    expect(turn.degraded).toBe(false);
    expect(turn.session).toMatchObject({ version: 2, turns: 1 });
    const card = turn.reply.cards.find((c) => c.doctor?.id === doctor.doctor.id);
    expect(card).toMatchObject({
      type: 'doctor',
      careStatus: 'active',
      doctor: { professionalName: 'Dr. asst-d1', primarySpecialization: 'General Medicine' },
    });
    expect(turn.reply.source).toBe('ai_assistant');

    // The backend ran exactly the planner's tools and sent the AI no patient data.
    expect(calls.map((c) => c.toolResult?.name ?? 'message')).toEqual([
      'message',
      'getPatientCareTeam',
      'searchDoctors',
    ]);
    for (const c of calls) {
      expect(c.patientId).toBe(patient.patient.id); // for the scope check only
      expect(JSON.stringify(c.toolResult ?? {})).not.toContain('person');
    }

    const row = await h.ownerKnex('agent_sessions').where({ id: s.id }).first();
    const audits = await auditFor(h.ownerKnex, { resource_id: s.id });
    for (const stored of [JSON.stringify(row), JSON.stringify(audits)]) {
      expect(stored).not.toContain('irritation');
      expect(stored).not.toContain('July');
    }
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining(['assistant.session_started', 'assistant.turn']),
    );
  });

  it('rejects tool argument manipulation, unknown tools and write tools', async () => {
    const patient = await createPatient(h, 'asst-p2');
    const other = await createPatient(h, 'asst-p2-other');
    const s = expectOk(await session(patient), 201);
    const results = [];
    const asks = [
      ['getPatientCareTeam', { patientId: other.patient.id }],
      ['createAppointment', { doctorId: randomUUID(), startsAt: new Date().toISOString() }],
      ['searchDoctors', { specialty: 'General Medicine; DROP TABLE doctors' }],
    ];
    script = (input) => {
      if (input.toolResult) results.push(input.toolResult);
      const next = asks[results.length];
      return next
        ? toolCall(input.state, ...next)
        : respond(input.state, { kind: 'help', message: 'Hello.', cards: [] });
    };
    const turn = expectOk(await say(patient, s, 'hello'));
    expect(turn.degraded).toBe(false);
    expect(results.map((r) => r.errorCode)).toEqual([
      'tool_invalid_arguments',
      'tool_unknown',
      'tool_invalid_arguments',
    ]);
    expect(results.every((r) => r.ok === false)).toBe(true);
  });

  it('drops forged doctor IDs, slots and state the backend did not produce', async () => {
    const patient = await createPatient(h, 'asst-p3');
    const s = expectOk(await session(patient), 201);
    const forged = randomUUID();
    script = (input) =>
      respond(
        {
          ...input.state,
          intent: 'find_doctor',
          candidateDoctorIds: [forged],
          selectedDoctorId: forged,
          slotStarts: ['2026-12-01T10:00:00Z'],
        },
        {
          kind: 'answer',
          message: 'Book Dr. Forged now.',
          cards: [
            { type: 'doctor', doctorId: forged },
            { type: 'slot', doctorId: forged, startsAt: '2026-12-01T10:00:00Z' },
            { type: 'link', target: 'my_doctors' },
          ],
        },
      );
    const turn = expectOk(await say(patient, s, 'book Dr. Forged'));
    expect(turn.reply.cards).toEqual([{ type: 'link', target: 'my_doctors' }]);
    const row = await h.ownerKnex('agent_sessions').where({ id: s.id }).first();
    expect(row.state).toMatchObject({
      candidateDoctorIds: [],
      selectedDoctorId: null,
      slotStarts: [],
    });

    // State outside the contract (e.g. a patient ID) is refused outright.
    script = (input) =>
      respond(
        { ...input.state, patientId: randomUUID() },
        { kind: 'help', message: 'Hi.', cards: [] },
      );
    const bad = expectOk(await say(patient, s, 'hi', turn.session.version));
    expect(bad.degraded).toBe(true);
    expect(bad.reply.kind).toBe('fallback');
  });

  it('fails safely when the AI is down, malformed or loops', async () => {
    const patient = await createPatient(h, 'asst-p4');
    let s = expectOk(await session(patient), 201);
    for (const broken of [
      () => {
        throw Object.assign(new Error('AI service responded 503'), { status: 503 });
      },
      () => ({ nonsense: true }),
      (input) => toolCall(input.state, 'getPatientCareTeam'), // never stops asking
    ]) {
      script = broken;
      calls.length = 0;
      const turn = expectOk(await say(patient, s, 'a doctor please'));
      expect(turn.degraded).toBe(true);
      expect(turn.reply).toMatchObject({
        kind: 'fallback',
        cards: [{ type: 'link', target: 'my_doctors' }],
      });
      expect(calls.length).toBeLessThanOrEqual(4); // one message step + at most 3 tool rounds
      s = turn.session;
    }
  });

  it('serialises turns: a stale version is refused', async () => {
    const patient = await createPatient(h, 'asst-p5');
    const s = expectOk(await session(patient), 201);
    script = (input) => respond(input.state, { kind: 'help', message: 'Hello.', cards: [] });
    expectOk(await say(patient, s, 'hello'));
    const stale = await say(patient, s, 'hello again', 1);
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('assistant_session_changed');
  });

  it('sessions are private to their user (API and RLS)', async () => {
    const owner = await createPatient(h, 'asst-owner');
    const stranger = await createPatient(h, 'asst-stranger');
    const s = expectOk(await session(owner), 201);
    script = (input) => respond(input.state, { kind: 'help', message: 'Hello.', cards: [] });
    expect((await api(h, stranger).get(`/assistant/sessions/${s.id}`)).status).toBe(404);
    expect((await say(stranger, s, 'hello')).status).toBe(404);
    // A session for someone else's patient profile cannot be opened.
    expect([403, 404]).toContain((await session(stranger, { patientId: owner.patient.id })).status);
    // RLS as the stranger, bypassing the API.
    const seen = await withActor(h.knex, stranger.id, (trx) =>
      trx('agent_sessions').where({ id: s.id }).select('id'),
    );
    expect(seen).toEqual([]);
    const updated = await withActor(h.knex, stranger.id, (trx) =>
      trx('agent_sessions').where({ id: s.id }).update({ status: 'ended' }),
    );
    expect(updated).toBe(0);
  });

  it('acts for a dependent through the guardianship, and stops when it is revoked', async () => {
    const guardian = await createPatient(h, 'asst-guardian');
    const dependent = expectOk(
      await api(h, guardian).post('/patients/me/dependents', {
        ...profileInput('Asst Child'),
        relationshipType: 'parent',
      }),
      201,
    );
    const s = expectOk(await session(guardian, { patientId: dependent.id }), 201);
    expect(s).toMatchObject({ actingFor: 'dependent', patientId: dependent.id });
    script = (input) => {
      expect(input.context.actingFor).toBe('dependent');
      return respond(input.state, { kind: 'help', message: 'Hello.', cards: [] });
    };
    const turn = expectOk(await say(guardian, s, 'hello'));
    await h
      .ownerKnex('patient_guardianships')
      .where({ patient_id: dependent.id, guardian_user_id: guardian.id })
      .update({ status: 'ended', ended_at: new Date() });
    const after = await say(guardian, s, 'hello', turn.session.version);
    expect([403, 404]).toContain(after.status);
  });

  it('is for patients only: admins and support are refused', async () => {
    const support = await createUser(h, { label: 'asst-support', roles: ['SUPPORT'] });
    for (const who of [admin, support]) {
      expect((await session(who)).status).toBe(403);
    }
  });

  it('ends, expires and purges sessions', async () => {
    const patient = await createPatient(h, 'asst-p6');
    const s = expectOk(await session(patient), 201);
    expect((await api(h, patient).post(`/assistant/sessions/${s.id}/messages`, {})).status).toBe(
      400,
    );
    const del = await request(h.app)
      .delete(`/api/v1/assistant/sessions/${s.id}`)
      .set(authHeader(patient.session));
    expect(del.status).toBe(204);
    expect((await say(patient, s, 'hello')).body.code).toBe('assistant_session_ended');

    // Expired sessions are refused and deleted by the retention sweep.
    const s2 = expectOk(await session(patient), 201);
    await h.ownerKnex.raw('ALTER TABLE agent_sessions DISABLE TRIGGER agent_sessions_guard');
    await h
      .ownerKnex('agent_sessions')
      .where({ id: s2.id })
      .update({
        created_at: new Date(Date.now() - 30 * 3_600_000),
        expires_at: new Date(Date.now() - 6 * 3_600_000),
      });
    await h.ownerKnex.raw('ALTER TABLE agent_sessions ENABLE TRIGGER agent_sessions_guard');
    expect((await say(patient, s2, 'hello')).body.code).toBe('assistant_session_ended');
    const purged = await h.container.assistantService.purgeExpired();
    expect(purged).toBeGreaterThanOrEqual(1);
    expect(await h.ownerKnex('agent_sessions').where({ id: s2.id }).first()).toBeUndefined();
  });
});

describe('M13.1 pre-merge hardening', () => {
  const insertAs = (userId, row) =>
    withActor(h.knex, userId, (trx) => trx('agent_sessions').insert(row));
  const sessionRow = (userId, patientId) => ({
    id: randomUUID(),
    user_id: userId,
    patient_id: patientId,
    state: {},
    expires_at: new Date(Date.now() + 3_600_000),
  });

  it('answers possible emergencies itself: no AI call, no tools, even with the AI down', async () => {
    const patient = await createPatient(h, 'asst-emergency');
    const s = expectOk(await session(patient), 201);
    script = () => {
      throw Object.assign(new Error('AI service responded 503'), { status: 503 });
    };
    calls.length = 0;
    const turn = expectOk(await say(patient, s, 'My mother has chest pain and fainted'));
    expect(calls).toHaveLength(0); // the AI service was never asked
    expect(turn.degraded).toBe(false);
    expect(turn.reply).toEqual({
      kind: 'emergency',
      message: ASSISTANT_EMERGENCY_MESSAGE,
      cards: [],
      source: 'safety_rule',
    });
    expect(turn.session).toMatchObject({ version: 2, turns: 1 });
    const audits = await auditFor(h.ownerKnex, { resource_id: s.id, action: 'assistant.turn' });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ reason: 'emergency' });
    expect(JSON.stringify(audits)).not.toContain('chest');
    // Even a stale version gets the guidance (and the session simply does not advance).
    const stale = expectOk(await say(patient, s, 'I cannot breathe', 1));
    expect(stale.reply.kind).toBe('emergency');
    expect(stale.session.version).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it('sends the AI service a keyed digest of the message, never a plain SHA-256', async () => {
    const patient = await createPatient(h, 'asst-digest');
    const doctor = await createVerifiedDoctor(h, admin, 'asst-digest-d');
    await linkCare(h, patient, doctor);
    const s = expectOk(await session(patient), 201);
    script = planner();
    calls.length = 0;
    const text = 'a general physician for my eczema please';
    expectOk(await say(patient, s, text));
    const key = deriveMessageDigestKey(h.config.clinicalData);
    expect(calls[0].messageDigest).toBe(createHmac('sha256', key).update(text).digest('hex'));
    expect(calls[0].messageDigest).not.toBe(createHash('sha256').update(text).digest('hex'));
    expect(JSON.stringify(calls)).not.toContain(key.toString('base64'));
    expect(JSON.stringify(calls)).not.toContain(key.toString('hex'));
    // Tool-result steps carry no message, so no digest either.
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.slice(1).every((c) => c.messageDigest === undefined)).toBe(true);
    // Nothing the backend stores or logs holds the message or its digest.
    const row = await h.ownerKnex('agent_sessions').where({ id: s.id }).first();
    const audits = await auditFor(h.ownerKnex, { resource_id: s.id });
    const stored = JSON.stringify([row, audits, h.logs]);
    expect(stored).not.toContain('eczema');
    expect(stored).not.toContain(calls[0].messageDigest);
  });

  it('RLS: a session can never name a patient unrelated to the user', async () => {
    const user = await createPatient(h, 'asst-rls-user');
    const stranger = await createPatient(h, 'asst-rls-stranger');
    // Creating one directly in the database, bypassing the API, is refused.
    await expect(insertAs(user.id, sessionRow(user.id, stranger.patient.id))).rejects.toThrow(
      /row-level security/,
    );
    // A row that somehow names an unrelated patient is invisible and unchangeable.
    const planted = sessionRow(user.id, stranger.patient.id);
    await h.ownerKnex('agent_sessions').insert(planted);
    const seen = await withActor(h.knex, user.id, (trx) =>
      trx('agent_sessions').where({ id: planted.id }).select('id'),
    );
    expect(seen).toEqual([]);
    const updated = await withActor(h.knex, user.id, (trx) =>
      trx('agent_sessions').where({ id: planted.id }).update({ status: 'ended' }),
    );
    expect(updated).toBe(0);
    expect((await api(h, user).get(`/assistant/sessions/${planted.id}`)).status).toBe(404);
    // Their own patient still works.
    await insertAs(user.id, sessionRow(user.id, user.patient.id));
  });

  it('RLS: a revoked guardianship ends access to existing sessions in the database', async () => {
    const guardian = await createPatient(h, 'asst-rls-guardian');
    const dependent = expectOk(
      await api(h, guardian).post('/patients/me/dependents', {
        ...profileInput('Rls Child'),
        relationshipType: 'parent',
      }),
      201,
    );
    const s = expectOk(await session(guardian, { patientId: dependent.id }), 201);
    const visible = () =>
      withActor(h.knex, guardian.id, (trx) =>
        trx('agent_sessions').where({ id: s.id }).select('id'),
      );
    expect(await visible()).toHaveLength(1);

    await h
      .ownerKnex('patient_guardianships')
      .where({ patient_id: dependent.id, guardian_user_id: guardian.id })
      .update({ status: 'ended', ended_at: new Date() });

    expect(await visible()).toEqual([]);
    const updated = await withActor(h.knex, guardian.id, (trx) =>
      trx('agent_sessions').where({ id: s.id }).update({ status: 'ended' }),
    );
    expect(updated).toBe(0);
    await expect(insertAs(guardian.id, sessionRow(guardian.id, dependent.id))).rejects.toThrow(
      /row-level security/,
    );
    expect((await api(h, guardian).get(`/assistant/sessions/${s.id}`)).status).toBe(404);
    expect((await say(guardian, s, 'hello')).status).toBe(404);
    // The retention sweep still sees it, so it is deleted on expiry.
    const swept = await withSystem(h.knex, 'assistant', (trx) =>
      trx('agent_sessions').where({ id: s.id }).select('id'),
    );
    expect(swept).toHaveLength(1);
  });

  it('a view-only guardian may still use the read-only assistant for the dependent', async () => {
    const owner = await createPatient(h, 'asst-view-owner');
    const viewer = await createPatient(h, 'asst-view-viewer');
    const dependent = expectOk(
      await api(h, owner).post('/patients/me/dependents', {
        ...profileInput('View Child'),
        relationshipType: 'parent',
      }),
      201,
    );
    await h.ownerKnex('patient_guardianships').insert({
      id: randomUUID(),
      patient_id: dependent.id,
      guardian_user_id: viewer.id,
      relationship_type: 'grandparent',
      access_scope: 'view',
      basis: 'legal_authority',
      status: 'active',
      started_at: new Date(),
      created_by_user_id: owner.id,
    });
    const s = expectOk(await session(viewer, { patientId: dependent.id }), 201);
    expect(s).toMatchObject({ actingFor: 'dependent', patientId: dependent.id });
    script = planner();
    const turn = expectOk(await say(viewer, s, 'a general physician for them'));
    expect(turn.degraded).toBe(false);
    expect(turn.session.version).toBe(2);
  });
});
