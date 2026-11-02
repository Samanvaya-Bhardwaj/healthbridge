import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { careAssistantStateSchema } from '@healthbridge/shared';
import { createAssistantService } from '../../src/modules/assistant/service.js';
import { createInputDigester } from '../../src/core/crypto/inputDigest.js';

const SESSION = '01a10227-3be6-7744-b9a6-1b48433f85e1';
const PATIENT = '01a10227-3be6-7744-b9a6-1b48433f85e2';
const DOCTOR = '01a10227-3be6-7744-b9a6-1b48433f85e3';
const SLOT = '2026-11-03T05:00:00Z';
const OTHER_SLOT = '2026-11-03T05:30:00Z';
const digester = createInputDigester({
  currentKeyId: 'd1',
  keys: new Map([['d1', randomBytes(32)]]),
});

const offered = careAssistantStateSchema.parse({
  intent: 'book_appointment',
  candidateDoctorIds: [DOCTOR],
  bookingDoctorId: DOCTOR,
  selectedDoctorId: DOCTOR,
  slotStarts: [SLOT, OTHER_SLOT],
});

/** One AI step that proposes `card`, over a state that chose `chosenStart`. */
function harness({ card, chosenStart = SLOT, slots = [] }) {
  const row = {
    id: SESSION,
    user_id: 'u1',
    patient_id: PATIENT,
    status: 'active',
    state: offered,
    version: 1,
    turn_count: 0,
    expires_at: new Date(Date.now() + 3_600_000),
  };
  const deps = {
    knex: { transaction: async (fn) => fn({ raw: async () => {} }) },
    aiClient: {
      agentStep: vi.fn(async () => ({
        state: { ...offered, chosenStart },
        action: { type: 'respond' },
        reply: { kind: 'confirm', message: 'Here’s the booking.', cards: [card] },
      })),
    },
    accessPolicy: { enforce: vi.fn(async () => ({ relationship: 'patient_self' })) },
    audit: { record: vi.fn(async () => {}) },
    repository: {
      find: vi.fn(async () => row),
      advance: vi.fn(async (_trx, _id, v) => ({ version: v + 1, turn_count: 1 })),
    },
    careService: { listForPatient: vi.fn(async () => []) },
    doctorService: { publicProfile: vi.fn() },
    availabilityService: { slots: vi.fn(async () => slots) },
    logger: { warn: vi.fn(), error: vi.fn() },
    inputDigester: digester,
  };
  const send = () =>
    createAssistantService(deps).sendMessage({ userId: 'u1', permissions: new Set() }, SESSION, {
      text: 'at 10:30',
      version: 1,
      timeZone: 'Asia/Kolkata',
    });
  return { send, deps };
}

const savedState = (deps) => deps.repository.advance.mock.calls[0][3].state;

describe('a proposed time that cannot be booked', () => {
  it('says so, and the next turn looks again instead of offering it once more', async () => {
    const { send, deps } = harness({
      card: { type: 'booking', doctorId: DOCTOR, startsAt: SLOT },
      slots: [], // taken since it was offered
    });
    const { reply } = await send();
    expect(reply.message).toMatch(/isn’t free any more/);
    expect(reply.cards).toEqual([]);
    expect(reply).not.toHaveProperty('timeGone');
    expect(savedState(deps)).toMatchObject({
      bookingDoctorId: DOCTOR,
      chosenStart: null,
      requestedTime: null,
      slotStarts: [],
    });
  });

  it('builds a proposal only for the doctor and time in the checked state', async () => {
    const { send, deps } = harness({
      // Not the time the state chose, though the doctor really is free then.
      card: { type: 'booking', doctorId: DOCTOR, startsAt: OTHER_SLOT },
      slots: [{ startsAt: OTHER_SLOT, endsAt: SLOT, mode: 'online', feePaise: 0 }],
    });
    const { reply } = await send();
    expect(reply.cards).toEqual([]);
    expect(deps.availabilityService.slots).not.toHaveBeenCalled();
    expect(deps.audit.record.mock.calls.map(([e]) => e.action)).not.toContain(
      'assistant.action_proposed',
    );
  });
});
