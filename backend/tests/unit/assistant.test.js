import { describe, expect, it, vi } from 'vitest';
import { careAssistantStateSchema } from '@healthbridge/shared';
import { calendarContext, slotQuery } from '../../src/modules/assistant/calendar.js';
import { createToolContext } from '../../src/modules/assistant/tools.js';
import { NotFoundError } from '../../src/core/http/errors.js';

const DOCTOR = '01a10227-3be6-7744-b9a6-1b48433f85ed';
const OTHER = '01a10227-3be6-7744-b9a6-1b48433f85ee';

describe('assistant calendar (resolved by the backend, in the person’s time zone)', () => {
  it('names today, tomorrow and the next weekdays locally', () => {
    // 20:00 UTC on Thursday 8 October is already Friday 9 October in India.
    const ctx = calendarContext('Asia/Kolkata', new Date('2026-10-08T20:00:00Z'));
    expect(ctx.today).toBe('2026-10-09');
    expect(ctx.tomorrow).toBe('2026-10-10');
    expect(ctx.weekdays).toMatchObject({ friday: '2026-10-09', monday: '2026-10-12' });
    expect(ctx.horizon).toBe('2026-12-08');
    expect(calendarContext('Mars/Olympus', new Date('2026-10-08T20:00:00Z')).today).toBe(
      '2026-10-09',
    ); // unknown zones fall back to Asia/Kolkata
  });

  it('keeps slots on the local day and inside the window', () => {
    const q = slotQuery(
      { date: '2026-10-10', timeWindow: 'evening' },
      'Asia/Kolkata',
      new Date('2026-10-09T04:00:00Z'),
    );
    expect([q.from, q.to]).toEqual(['2026-10-09', '2026-10-11']);
    expect(q.keep({ startsAt: '2026-10-10T13:00:00Z' })).toBe(true); // 18:30 IST
    expect(q.keep({ startsAt: '2026-10-10T05:00:00Z' })).toBe(false); // 10:30 IST
    expect(q.keep({ startsAt: '2026-10-11T13:00:00Z' })).toBe(false); // next day
  });
});

describe('assistant tool registry', () => {
  const principal = { userId: 'u1', permissions: new Set() };
  const deps = (overrides = {}) => ({
    accessPolicy: { evaluate: vi.fn(async () => ({ allowed: true })) },
    careService: {
      listForPatient: vi.fn(async () => [
        {
          doctorId: DOCTOR,
          status: 'active',
          doctor: { professionalName: 'Dr. Synthetic', primarySpecialization: 'Dermatology' },
        },
      ]),
    },
    doctorService: {
      directory: vi.fn(async () => ({
        items: [
          {
            id: DOCTOR,
            professionalName: 'Dr. Synthetic',
            primarySpecialization: 'Dermatology',
            languages: ['Hindi'],
          },
          {
            id: OTHER,
            professionalName: 'Dr. Other',
            primarySpecialization: 'Dermatology',
            languages: ['English'],
          },
        ],
      })),
      publicProfile: vi.fn(async (id) => {
        if (id !== DOCTOR) throw new NotFoundError();
        return { id, professionalName: 'Dr. Synthetic', primarySpecialization: 'Dermatology' };
      }),
    },
    availabilityService: { slots: vi.fn(async () => []) },
    ...overrides,
  });
  const ctx = (d) =>
    createToolContext(d, {
      principal,
      patientId: 'p1',
      actingFor: 'self',
      timeZone: 'Asia/Kolkata',
    });

  it('runs the care team for the session’s patient, never one the AI names', async () => {
    const d = deps();
    const tools = ctx(d);
    expect(await tools.execute('getPatientCareTeam', {})).toEqual({
      ok: true,
      data: { doctors: [{ doctorId: DOCTOR, status: 'active' }] },
    });
    expect(d.careService.listForPatient).toHaveBeenCalledWith(principal, 'p1', undefined);
    expect(await tools.execute('getPatientCareTeam', { patientId: 'p2' })).toEqual({
      ok: false,
      errorCode: 'tool_invalid_arguments',
    });
  });

  it('filters search by language and marks care-team doctors; returns no patient data', async () => {
    const tools = ctx(deps());
    const res = await tools.execute('searchDoctors', {
      specialty: 'Dermatology',
      language: 'Hindi',
    });
    expect(res).toEqual({
      ok: true,
      data: {
        doctors: [
          { doctorId: DOCTOR, specialty: 'Dermatology', languages: ['Hindi'], inCareTeam: true },
        ],
      },
    });
    expect(tools.evidence.doctors.get(DOCTOR).professionalName).toBe('Dr. Synthetic');
  });

  it('refuses unknown tools, bad arguments, missing permission and maps domain errors', async () => {
    const denied = ctx(deps({ accessPolicy: { evaluate: async () => ({ allowed: false }) } }));
    expect((await denied.execute('searchDoctors', { specialty: 'Dermatology' })).errorCode).toBe(
      'tool_forbidden',
    );
    const tools = ctx(deps());
    expect((await tools.execute('cancelAppointment', {})).errorCode).toBe('tool_unknown');
    expect((await tools.execute('__proto__', {})).errorCode).toBe('tool_unknown');
    expect((await tools.execute('searchDoctors', {})).errorCode).toBe('tool_invalid_arguments');
    expect((await tools.execute('searchDoctors', { specialty: 'Astrology' })).errorCode).toBe(
      'tool_invalid_arguments',
    );
    expect((await tools.execute('getDoctorProfile', { doctorId: OTHER })).errorCode).toBe(
      'not_found',
    );
  });

  it('never throws on unexpected failures', async () => {
    const tools = ctx(
      deps({ doctorService: { directory: async () => Promise.reject(new Error('db down')) } }),
    );
    expect(await tools.execute('searchDoctors', { specialty: 'Dermatology' })).toEqual({
      ok: false,
      errorCode: 'tool_failed',
    });
  });
});

describe('care assistant state contract', () => {
  it('is bounded and rejects anything outside it', () => {
    expect(careAssistantStateSchema.safeParse({ transcript: 'hello' }).success).toBe(false);
    expect(careAssistantStateSchema.safeParse({ patientId: DOCTOR }).success).toBe(false);
    expect(
      careAssistantStateSchema.safeParse({ candidateDoctorIds: Array(6).fill(DOCTOR) }).success,
    ).toBe(false);
    expect(
      careAssistantStateSchema.safeParse({ criteria: { specialty: 'Astrology' } }).success,
    ).toBe(false);
  });
});
