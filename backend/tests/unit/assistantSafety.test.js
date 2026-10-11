import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  ASSISTANT_EMERGENCY_ALTERNATIVES,
  ASSISTANT_EMERGENCY_MESSAGE,
  careAssistantStateSchema,
  isPossibleAssistantEmergency,
} from '@healthbridge/shared';
import {
  createAssistantService,
  deriveMessageDigestKey,
} from '../../src/modules/assistant/service.js';

const SESSION = '01a10227-3be6-7744-b9a6-1b48433f85e1';
const PATIENT = '01a10227-3be6-7744-b9a6-1b48433f85e2';
const KEY = randomBytes(32);

describe('emergency wording: one rule shared by the backend and the AI service', () => {
  // The backend screens with the shared JS copy; the AI service keeps the Python copy as
  // a second line. They must be the same rule, not two policies that drift apart.
  const python = readFileSync(
    fileURLToPath(new URL('../../../ai-service/app/agents/care_safety.py', import.meta.url)),
    'utf8',
  );

  it('mirrors care_safety.py exactly (pattern and fixed guidance)', () => {
    const block = python.match(/_EMERGENCY = re\.compile\(\s*r"\\b\("\s*([\s\S]*?)\s*r"\)\\b",/);
    expect(block).not.toBeNull();
    const alternatives = [...block[1].matchAll(/r"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
    expect(alternatives).toEqual([...ASSISTANT_EMERGENCY_ALTERNATIVES]);

    const message = python.match(/EMERGENCY_MESSAGE = \(\s*"([^"]*)"\s*"([^"]*)"\s*\)/);
    expect(message).not.toBeNull();
    expect(message[1] + message[2]).toBe(ASSISTANT_EMERGENCY_MESSAGE);
    expect(python).toMatch(/re\.I\b/); // case-insensitive in both
  });

  it.each([
    'I have chest pain',
    "I can't breathe",
    'my father fainted',
    'thinking about suicide',
    'SEVERE BLEEDING from a cut',
    'she is having a seizure',
  ])('flags "%s"', (text) => {
    expect(isPossibleAssistantEmergency(text)).toBe(true);
  });

  it.each(['I want a dermatologist tomorrow evening', 'a doctor for my cough', ''])(
    'does not flag "%s"',
    (text) => {
      expect(isPossibleAssistantEmergency(text)).toBe(false);
    },
  );
});

/** A service over fakes: a pass-through transaction, and AI/tool spies. */
function harness({ aiClient = null, advance, version = 1, turns = 0 } = {}) {
  const row = {
    id: SESSION,
    user_id: 'u1',
    patient_id: PATIENT,
    status: 'active',
    state: careAssistantStateSchema.parse({ intent: 'find_doctor' }),
    version,
    turn_count: turns,
    expires_at: new Date(Date.now() + 3_600_000),
  };
  const deps = {
    knex: { transaction: async (fn) => fn({ raw: async () => {} }) },
    aiClient,
    accessPolicy: { enforce: vi.fn(async () => ({ relationship: 'patient_self' })) },
    audit: { record: vi.fn(async () => {}) },
    repository: {
      find: vi.fn(async () => row),
      advance: vi.fn(
        advance ?? (async (_trx, _id, v) => ({ version: v + 1, turn_count: row.turn_count + 1 })),
      ),
    },
    careService: { listForPatient: vi.fn() },
    doctorService: { directory: vi.fn(), publicProfile: vi.fn() },
    availabilityService: { slots: vi.fn() },
    logger: { warn: vi.fn(), error: vi.fn() },
    messageDigestKey: KEY,
  };
  return { service: createAssistantService(deps), deps };
}

const principal = { userId: 'u1', permissions: new Set() };
const EMERGENCY = 'I have chest pain and my arm is numb';
const send = (service, text = EMERGENCY, version = 1) =>
  service.sendMessage(principal, SESSION, { text, version, timeZone: 'Asia/Kolkata' });

function expectFixedGuidanceWithoutAiOrTools(result, deps) {
  expect(result.reply).toEqual({
    kind: 'emergency',
    message: ASSISTANT_EMERGENCY_MESSAGE,
    cards: [],
    source: 'safety_rule',
  });
  expect(result.degraded).toBe(false);
  expect(deps.careService.listForPatient).not.toHaveBeenCalled();
  expect(deps.doctorService.directory).not.toHaveBeenCalled();
  expect(deps.doctorService.publicProfile).not.toHaveBeenCalled();
  expect(deps.availabilityService.slots).not.toHaveBeenCalled();
}

describe('emergency guidance survives AI-service failure (backend-owned)', () => {
  const failures = {
    'the AI service is not configured': () => null,
    'the AI service is unavailable (503)': () => ({
      agentStep: vi.fn(async () => {
        throw Object.assign(new Error('AI service responded 503'), { status: 503 });
      }),
    }),
    'the AI service times out (never answers)': () => ({
      agentStep: vi.fn(() => new Promise(() => {})),
    }),
    'the AI call fails before returning a response': () => ({
      agentStep: vi.fn(() => {
        throw new TypeError('fetch failed');
      }),
    }),
    'the AI run-record write would fail': () => ({
      agentStep: vi.fn(async () => {
        throw Object.assign(new Error('ai_runs insert failed'), { status: 500 });
      }),
    }),
  };

  for (const [name, makeClient] of Object.entries(failures)) {
    it(`answers with the fixed guidance when ${name}`, async () => {
      const aiClient = makeClient();
      const { service, deps } = harness({ aiClient });
      const result = await send(service);
      expectFixedGuidanceWithoutAiOrTools(result, deps);
      if (aiClient) expect(aiClient.agentStep).not.toHaveBeenCalled();
      expect(result.session.version).toBe(2);
      // Recorded as a turn with no tools and no AI call; never the message.
      const event = deps.audit.record.mock.calls[0][0];
      expect(event).toMatchObject({ action: 'assistant.turn', reason: 'emergency' });
      expect(event.metadata).toMatchObject({ tools: [], cards: 0, ai: false });
      expect(JSON.stringify(deps.audit.record.mock.calls)).not.toContain('chest');
      // State is kept as it was: nothing from the message is remembered.
      expect(deps.repository.advance.mock.calls[0][3]).toEqual({
        state: careAssistantStateSchema.parse({ intent: 'find_doctor' }),
      });
    });
  }

  it('is not blocked by a stale version or the turn limit', async () => {
    const aiClient = { agentStep: vi.fn() };
    const stale = harness({ aiClient, version: 3 });
    const res = await send(stale.service, EMERGENCY, 2);
    expectFixedGuidanceWithoutAiOrTools(res, stale.deps);
    expect(stale.deps.repository.advance).not.toHaveBeenCalled();
    expect(res.session.version).toBe(3); // the current version, so the next turn works

    const full = harness({ aiClient, turns: 40 });
    expectFixedGuidanceWithoutAiOrTools(await send(full.service), full.deps);
    expect(aiClient.agentStep).not.toHaveBeenCalled();
  });

  it('still answers when recording the turn fails', async () => {
    const { service, deps } = harness({
      advance: async () => {
        throw new Error('database unavailable');
      },
    });
    const res = await send(service);
    expectFixedGuidanceWithoutAiOrTools(res, deps);
    expect(deps.logger.error).toHaveBeenCalledWith(
      { errName: 'Error' },
      'assistant emergency turn not recorded',
    );
    expect(JSON.stringify(deps.logger.error.mock.calls)).not.toContain('chest');
  });

  it('ordinary messages still go to the AI service (and degrade to the fallback)', async () => {
    const aiClient = { agentStep: vi.fn(async () => Promise.reject(new Error('down'))) };
    const { service } = harness({ aiClient });
    const res = await send(service, 'I need a dermatologist tomorrow');
    expect(aiClient.agentStep).toHaveBeenCalledTimes(1);
    expect(res.degraded).toBe(true);
    expect(res.reply.kind).toBe('fallback');
  });
});

describe('message digest kept with the AI run record', () => {
  it('is a keyed HMAC from a backend-only key, never a plain SHA-256 of the text', async () => {
    const text = 'I need a dermatologist for my rash';
    const aiClient = {
      agentStep: vi.fn(async (input) => ({
        state: input.state,
        action: { type: 'respond' },
        reply: { kind: 'help', message: 'Hello.', cards: [] },
      })),
    };
    const { service, deps } = harness({ aiClient });
    await send(service, text);
    const sent = aiClient.agentStep.mock.calls[0][0];
    expect(sent.messageDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(sent.messageDigest).toBe(createHmac('sha256', KEY).update(text).digest('hex'));
    expect(sent.messageDigest).not.toBe(createHash('sha256').update(text).digest('hex'));
    // The key itself never travels to the AI service.
    const wire = JSON.stringify(sent);
    expect(wire).not.toContain(KEY.toString('hex'));
    expect(wire).not.toContain(KEY.toString('base64'));
    // Nothing the backend records or logs carries the message.
    const recorded = JSON.stringify([
      deps.audit.record.mock.calls,
      deps.repository.advance.mock.calls,
      deps.logger.warn.mock.calls,
      deps.logger.error.mock.calls,
    ]);
    expect(recorded).not.toContain('rash');
    expect(recorded).not.toContain(sent.messageDigest);
  });

  it('derives a dedicated key from the clinical data key, and requires one', () => {
    const kek = randomBytes(32);
    const clinicalData = { currentKeyId: 'k1', keys: new Map([['k1', kek]]) };
    const key = deriveMessageDigestKey(clinicalData);
    expect(key).toHaveLength(32);
    expect(key.equals(kek)).toBe(false); // purpose-separated, not the key-encryption key
    expect(deriveMessageDigestKey(clinicalData).equals(key)).toBe(true); // stable
    expect(() => deriveMessageDigestKey({ currentKeyId: 'k2', keys: new Map() })).toThrow();
    expect(() => createAssistantService({ messageDigestKey: null })).toThrow(/digest key/);
  });
});
