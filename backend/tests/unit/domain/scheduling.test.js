import { describe, expect, it } from 'vitest';
import {
  findSlot,
  generateSlots,
  rulesOverlap,
} from '../../../src/modules/scheduling/domain/slots.js';
import {
  appointmentTransition,
  initialStatus,
} from '../../../src/modules/scheduling/domain/appointmentStateMachine.js';
import { ConflictError, ForbiddenError } from '../../../src/core/http/errors.js';

// Monday 2026-10-05 in India.
const rule = (overrides = {}) => ({
  id: 'r1',
  mode: 'online',
  clinic_id: null,
  weekday: 1,
  start_time: '09:00:00',
  end_time: '10:00:00',
  slot_minutes: 15,
  timezone: 'Asia/Kolkata',
  valid_from: '2026-01-01',
  valid_until: null,
  fee_paise: 0,
  ...overrides,
});
const base = (overrides = {}) => ({
  rules: [rule()],
  exceptions: [],
  busy: [],
  from: '2026-10-05',
  to: '2026-10-05',
  now: new Date('2026-10-01T00:00:00Z'),
  leadMinutes: 30,
  horizonDays: 60,
  ...overrides,
});

describe('slot generation', () => {
  it('creates slots from a weekly rule in the rule timezone, returned in UTC', () => {
    const slots = generateSlots(base());
    expect(slots.map((s) => s.startsAt)).toEqual([
      '2026-10-05T03:30:00Z', // 09:00 IST
      '2026-10-05T03:45:00Z',
      '2026-10-05T04:00:00Z',
      '2026-10-05T04:15:00Z',
    ]);
    expect(slots[0]).toMatchObject({
      endsAt: '2026-10-05T03:45:00Z',
      mode: 'online',
      ruleId: 'r1',
    });
  });

  it('ignores other weekdays and dates outside the rule validity', () => {
    expect(generateSlots(base({ from: '2026-10-06', to: '2026-10-06' }))).toEqual([]);
    expect(generateSlots(base({ rules: [rule({ valid_from: '2026-10-06' })] }))).toEqual([]);
    expect(generateSlots(base({ rules: [rule({ valid_until: '2026-10-04' })] }))).toEqual([]);
  });

  it('drops a trailing partial slot', () => {
    expect(
      generateSlots(base({ rules: [rule({ end_time: '09:40:00', slot_minutes: 20 })] })),
    ).toHaveLength(2);
  });

  it('respects lead time and booking horizon', () => {
    const now = new Date('2026-10-05T03:40:00Z'); // 09:10 IST → earliest 09:40
    expect(generateSlots(base({ now })).map((s) => s.startsAt)).toEqual(['2026-10-05T04:15:00Z']);
    expect(generateSlots(base({ now: new Date('2026-07-01T00:00:00Z') }))).toEqual([]); // > 60 days ahead
  });

  it('removes slots overlapping time off or busy appointments', () => {
    const busy = [
      { starts_at: new Date('2026-10-05T03:45:00Z'), ends_at: new Date('2026-10-05T04:00:00Z') },
    ];
    const exceptions = [
      { starts_at: new Date('2026-10-05T04:10:00Z'), ends_at: new Date('2026-10-05T05:00:00Z') },
    ];
    expect(generateSlots(base({ busy, exceptions })).map((s) => s.startsAt)).toEqual([
      '2026-10-05T03:30:00Z',
    ]);
  });

  it('filters by mode and clinic', () => {
    const rules = [
      rule(),
      rule({
        id: 'r2',
        mode: 'in_clinic',
        clinic_id: 'c1',
        start_time: '11:00:00',
        end_time: '11:30:00',
      }),
    ];
    expect(
      generateSlots(base({ rules, mode: 'in_clinic' })).every((s) => s.clinicId === 'c1'),
    ).toBe(true);
    expect(generateSlots(base({ rules, clinicId: 'c1' }))).toHaveLength(2);
  });

  it('works for any IANA zone (DST-observing zone shifts the UTC time)', () => {
    const london = rule({ timezone: 'Europe/London', weekday: 7 });
    const summer = generateSlots(base({ rules: [london], from: '2026-10-18', to: '2026-10-18' }));
    const winter = generateSlots(base({ rules: [london], from: '2026-11-01', to: '2026-11-01' }));
    expect(summer[0].startsAt).toBe('2026-10-18T08:00:00Z'); // BST (UTC+1)
    expect(winter[0].startsAt).toBe('2026-11-01T09:00:00Z'); // GMT
  });

  it('findSlot matches only exact, bookable slot starts', () => {
    const input = base();
    expect(
      findSlot(input, { startsAt: '2026-10-05T09:15:00+05:30', mode: 'online' }),
    ).toMatchObject({
      startsAt: '2026-10-05T03:45:00Z',
    });
    expect(findSlot(input, { startsAt: '2026-10-05T09:10:00+05:30', mode: 'online' })).toBeNull(); // misaligned
    expect(
      findSlot(input, { startsAt: '2026-10-05T09:15:00+05:30', mode: 'in_clinic' }),
    ).toBeNull();
    expect(findSlot(input, { startsAt: 'not-a-date', mode: 'online' })).toBeNull();
  });

  it('detects overlapping weekly rules', () => {
    expect(rulesOverlap(rule(), rule({ start_time: '09:30:00', end_time: '11:00:00' }))).toBe(true);
    expect(rulesOverlap(rule(), rule({ start_time: '10:00:00', end_time: '11:00:00' }))).toBe(
      false,
    );
    expect(rulesOverlap(rule(), rule({ weekday: 2 }))).toBe(false);
    expect(
      rulesOverlap(rule({ valid_until: '2026-03-01' }), rule({ valid_from: '2026-04-01' })),
    ).toBe(false);
  });
});

describe('appointment state machine', () => {
  const at = (iso) => new Date(iso);
  const appt = (overrides = {}) => ({
    status: 'confirmed',
    mode: 'in_clinic',
    starts_at: at('2026-10-05T04:00:00Z'),
    ends_at: at('2026-10-05T04:15:00Z'),
    hold_expires_at: null,
    ...overrides,
  });

  it('initial status depends on the fee', () => {
    expect(initialStatus(0)).toBe('confirmed');
    expect(initialStatus(50000)).toBe('pending_payment');
  });

  it('patients can cancel before the start, not after', () => {
    expect(appointmentTransition(appt(), 'cancel', 'patient', at('2026-10-05T03:00:00Z'))).toBe(
      'cancelled',
    );
    expect(() =>
      appointmentTransition(appt(), 'cancel', 'patient', at('2026-10-05T04:05:00Z')),
    ).toThrow(ConflictError);
    expect(appointmentTransition(appt(), 'cancel', 'doctor', at('2026-10-05T04:05:00Z'))).toBe(
      'cancelled',
    );
  });

  it('check-in is for in-clinic visits within the window, by doctor or clinic', () => {
    expect(appointmentTransition(appt(), 'check_in', 'clinic', at('2026-10-05T03:30:00Z'))).toBe(
      'checked_in',
    );
    expect(() =>
      appointmentTransition(appt(), 'check_in', 'patient', at('2026-10-05T03:30:00Z')),
    ).toThrow(ForbiddenError);
    expect(() =>
      appointmentTransition(
        appt({ mode: 'online' }),
        'check_in',
        'doctor',
        at('2026-10-05T03:30:00Z'),
      ),
    ).toThrow(ConflictError);
    expect(() =>
      appointmentTransition(appt(), 'check_in', 'doctor', at('2026-10-05T01:00:00Z')),
    ).toThrow(ConflictError);
  });

  it('only the doctor completes, and only after the start', () => {
    expect(
      appointmentTransition(
        appt({ status: 'checked_in' }),
        'complete',
        'doctor',
        at('2026-10-05T04:10:00Z'),
      ),
    ).toBe('completed');
    expect(() =>
      appointmentTransition(appt(), 'complete', 'clinic', at('2026-10-05T04:10:00Z')),
    ).toThrow(ForbiddenError);
    expect(() =>
      appointmentTransition(appt(), 'complete', 'doctor', at('2026-10-05T03:00:00Z')),
    ).toThrow(ConflictError);
  });

  it('no-show only after the grace period', () => {
    expect(() =>
      appointmentTransition(appt(), 'no_show', 'doctor', at('2026-10-05T04:10:00Z')),
    ).toThrow(ConflictError);
    expect(appointmentTransition(appt(), 'no_show', 'clinic', at('2026-10-05T04:20:00Z'))).toBe(
      'no_show',
    );
  });

  it('terminal and expired appointments cannot change', () => {
    for (const status of ['cancelled', 'completed', 'no_show', 'expired']) {
      expect(() =>
        appointmentTransition(appt({ status }), 'cancel', 'doctor', at('2026-10-05T03:00:00Z')),
      ).toThrow(ConflictError);
    }
    const expiredHold = appt({
      status: 'pending_payment',
      hold_expires_at: at('2026-10-05T02:00:00Z'),
    });
    expect(() =>
      appointmentTransition(expiredHold, 'cancel', 'patient', at('2026-10-05T03:00:00Z')),
    ).toThrow(ConflictError);
  });
});
