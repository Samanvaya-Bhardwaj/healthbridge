import { createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  ASSISTANT_EMERGENCY_ALTERNATIVES,
  ASSISTANT_EMERGENCY_APOSTROPHES,
  ASSISTANT_EMERGENCY_DASHES,
  ASSISTANT_EMERGENCY_MESSAGE,
  ASSISTANT_EMERGENCY_WHITESPACE,
  careAssistantStateSchema,
  isPossibleAssistantEmergency,
  normalizeForEmergencyScreening,
} from '@healthbridge/shared';
import { createAssistantService } from '../../src/modules/assistant/service.js';
import {
  AI_INPUT_DIGEST_PURPOSES,
  createInputDigester,
} from '../../src/core/crypto/inputDigest.js';
import { loadConfig } from '../../src/config/index.js';
import { validEnv } from '../helpers.js';

const SESSION = '01a10227-3be6-7744-b9a6-1b48433f85e1';
const PATIENT = '01a10227-3be6-7744-b9a6-1b48433f85e2';
const KEY = randomBytes(32);
const DIGESTER = createInputDigester({ currentKeyId: 'd1', keys: new Map([['d1', KEY]]) });

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

  it('normalises text exactly like care_safety.py (apostrophes, dashes, NFKC, whitespace)', () => {
    // Python string literal → its characters (\uXXXX, \t, \n, \r, \f, \v escapes only).
    const decode = (literal) =>
      JSON.parse(`"${literal.replaceAll(String.raw`\v`, String.raw`\u000b`)}"`);
    const constant = (name) => {
      const m = python.match(new RegExp(`^${name} = "((?:[^"\\\\]|\\\\.)*)"$`, 'm'));
      expect(m, name).not.toBeNull();
      return decode(m[1]);
    };
    expect(constant('APOSTROPHES')).toBe(ASSISTANT_EMERGENCY_APOSTROPHES);
    expect(constant('WHITESPACE')).toBe(ASSISTANT_EMERGENCY_WHITESPACE);
    expect(constant('DASHES')).toBe(ASSISTANT_EMERGENCY_DASHES);
    expect(python).toContain(
      'unicodedata.normalize("NFKC", text.translate(_CHARACTER_MAP))', // same order
    );
    expect(normalizeForEmergencyScreening('I can’t \n breathe')).toBe("I can't breathe");
  });

  // The same cases run in the AI service's pytest suite, so both implementations must agree.
  const cases = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL('../../../ai-service/tests/fixtures/emergency_cases.json', import.meta.url),
      ),
      'utf8',
    ),
  );

  it.each(cases.emergency)('flags %j', (text) => {
    expect(isPossibleAssistantEmergency(text)).toBe(true);
  });

  it.each(cases.not_emergency)('does not flag %j', (text) => {
    expect(isPossibleAssistantEmergency(text)).toBe(false);
  });

  it('covers curly and straight apostrophes, case and punctuation', () => {
    const all = cases.emergency.join('\n');
    for (const needle of ["can't", 'can’t', 'CAN’T'.toLowerCase(), 'CHEST PAIN', '!!!']) {
      expect(all.toLowerCase()).toContain(needle.toLowerCase());
    }
    expect(cases.emergency.length).toBeGreaterThanOrEqual(30);
  });
});

/** A service over fakes: a pass-through transaction, and AI/tool spies. */
function harness({
  aiClient = null,
  advance,
  version = 1,
  turns = 0,
  status = 'active',
  expiresInMs = 3_600_000,
} = {}) {
  const row = {
    id: SESSION,
    user_id: 'u1',
    patient_id: PATIENT,
    status,
    state: careAssistantStateSchema.parse({ intent: 'find_doctor' }),
    version,
    turn_count: turns,
    expires_at: new Date(Date.now() + expiresInMs),
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
    inputDigester: DIGESTER,
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

  it('answers even in an ended or expired conversation (without advancing it)', async () => {
    for (const opts of [{ status: 'ended' }, { expiresInMs: -1000 }]) {
      const aiClient = { agentStep: vi.fn() };
      const { service, deps } = harness({ aiClient, ...opts });
      const res = await send(service);
      expectFixedGuidanceWithoutAiOrTools(res, deps);
      expect(deps.repository.advance).not.toHaveBeenCalled();
      expect(aiClient.agentStep).not.toHaveBeenCalled();
      // Ordinary messages are still refused there.
      await expect(send(service, 'a dermatologist please')).rejects.toMatchObject({
        code: 'assistant_session_ended',
      });
    }
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

describe('keyed digests of free-text AI inputs', () => {
  const subkey = (key, purpose) =>
    Buffer.from(hkdfSync('sha256', key, 'healthbridge', `ai-input-digest/${purpose}/v1`, 32));

  it('the assistant sends a keyed digest with its key ID, never a plain SHA-256', async () => {
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
    expect(sent.messageDigest).toBeUndefined();
    expect(sent.inputDigest).toEqual({
      keyId: 'd1',
      value: createHmac('sha256', subkey(KEY, 'care_assistant_message')).update(text).digest('hex'),
    });
    expect(sent.inputDigest.value).not.toBe(createHash('sha256').update(text).digest('hex'));
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
    expect(recorded).not.toContain(sent.inputDigest.value);
  });

  it('separates purposes, is stable for one key, and changes with the key', () => {
    const text = 'same words';
    const values = AI_INPUT_DIGEST_PURPOSES.map((p) => DIGESTER.digest(p, text).value);
    expect(new Set(values).size).toBe(AI_INPUT_DIGEST_PURPOSES.length);
    expect(DIGESTER.digest('record_question', text)).toEqual(
      DIGESTER.digest('record_question', text),
    );
    const rotated = createInputDigester({
      currentKeyId: 'd2',
      keys: new Map([['d2', randomBytes(32)]]),
    }).digest('record_question', text);
    expect(rotated.keyId).toBe('d2');
    expect(rotated.value).not.toBe(DIGESTER.digest('record_question', text).value);
    // Structured input is encoded as JSON (the follow-up summary's [id, texts]).
    expect(DIGESTER.digest('follow_up_summary', ['f1', ['a', 'b']]).value).toBe(
      createHmac('sha256', subkey(KEY, 'follow_up_summary'))
        .update(JSON.stringify(['f1', ['a', 'b']]))
        .digest('hex'),
    );
    expect(() => DIGESTER.digest('telemetry', text)).toThrow(/unknown/);
    expect(() =>
      createInputDigester({ currentKeyId: 'd1', keys: new Map([['d1', Buffer.alloc(16)]]) }),
    ).toThrow(/32 bytes/);
    expect(() => createAssistantService({ inputDigester: null })).toThrow(/digester/);
  });

  it('uses a dedicated secret: required outside development/test, never the clinical key', () => {
    const issues = (env) => {
      try {
        loadConfig({ ...validEnv, ...env });
        return [];
      } catch (err) {
        return err.issues.map((i) => i.variable);
      }
    };
    expect(issues({ APP_ENV: 'staging' })).toContain('AI_INPUT_DIGEST_KEY');
    expect(issues({ AI_INPUT_DIGEST_KEY: Buffer.alloc(16).toString('base64') })).toContain(
      'AI_INPUT_DIGEST_KEY',
    );
    const key = randomBytes(32);
    const config = loadConfig({
      ...validEnv,
      AI_INPUT_DIGEST_KEY: key.toString('base64'),
      AI_INPUT_DIGEST_KEY_ID: 'd7',
    });
    expect(config.aiInputDigest.currentKeyId).toBe('d7');
    expect(config.aiInputDigest.keys.get('d7').equals(key)).toBe(true);
    // Without one (development/test): a random per-process key, unrelated to other secrets.
    const dev = loadConfig(validEnv);
    const devKey = dev.aiInputDigest.keys.get('d1');
    expect(devKey).toHaveLength(32);
    expect(devKey.equals(dev.clinicalData.keys.get('k1'))).toBe(false);
    expect(devKey.equals(loadConfig(validEnv).aiInputDigest.keys.get('d1'))).toBe(false);
  });
});
