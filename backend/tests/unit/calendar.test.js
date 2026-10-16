import { describe, expect, it } from 'vitest';
import {
  buildIcs,
  escapeText,
  foldLine,
  icsTime,
  mailAddress,
} from '../../src/core/calendar/ics.js';
import { appointmentIcs } from '../../src/modules/scheduling/calendarEvent.js';

/** Step 7+: calendar invitations for appointments (RFC 5545). */
const BS = String.fromCharCode(92);
const facts = (over = {}) => ({
  id: '0192b6f0-0000-7000-8000-00000000abcd',
  root_id: '0192b6f0-0000-7000-8000-00000000abcd',
  depth: 0,
  status: 'confirmed',
  mode: 'online',
  starts_at: new Date('2026-10-20T05:00:00Z'),
  ends_at: new Date('2026-10-20T05:15:00Z'),
  doctor_name: 'Dr. Meera Iyer',
  patient_name: 'Kamala Rao',
  clinic_name: null,
  ...over,
});
const options = { appUrl: 'https://health.example.org', from: 'HealthBridge <no-reply@x.org>' };
const unfold = (ics) => ics.replace(/\r\n /g, '');

describe('iCalendar building blocks', () => {
  it('escapes text and folds long lines without splitting a character', () => {
    expect(escapeText(`a,b;c${BS}d\ne`)).toBe(`a${BS},b${BS};c${BS}${BS}d${BS}ne`);
    const long = `SUMMARY:${'é'.repeat(60)}`;
    const folded = foldLine(long);
    for (const line of folded.split('\r\n'))
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    expect(folded.replace(/\r\n /g, '')).toBe(long);
    expect(icsTime('2026-10-20T05:00:00.000Z')).toBe('20261020T050000Z');
    expect(mailAddress('HealthBridge <no-reply@x.org>')).toBe('no-reply@x.org');
  });

  it('builds a complete event with CRLF lines', () => {
    const ics = buildIcs({
      method: 'REQUEST',
      uid: 'u1@hb',
      sequence: 0,
      startsAt: '2026-10-20T05:00:00Z',
      endsAt: '2026-10-20T05:15:00Z',
      summary: 'S',
      description: 'D',
      location: 'L',
      alarmMinutes: 30,
      stamp: new Date('2026-10-16T00:00:00Z'),
    });
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics).toContain('METHOD:REQUEST\r\n');
    expect(ics).toContain('TRIGGER:-PT30M');
    expect(ics.split('\r\n').every((l) => !l.includes('\n'))).toBe(true);
  });
});

describe('appointment invitations', () => {
  it('describe the visit without clinical content, for self or a dependent', () => {
    const own = unfold(appointmentIcs(facts(), { ...options, method: 'REQUEST' }));
    expect(own).toContain('SUMMARY:HealthBridge: online consultation with Dr. Meera Iyer');
    expect(own).toContain('UID:appointment-0192b6f0-0000-7000-8000-00000000abcd@healthbridge');
    expect(own).toContain('URL:https://health.example.org/app/appointments/');
    expect(own).toContain('ORGANIZER;CN=HealthBridge:mailto:no-reply@x.org');
    const theirs = unfold(
      appointmentIcs(facts({ mode: 'in_clinic', clinic_name: 'Sunrise Family Clinic' }), {
        ...options,
        method: 'REQUEST',
        forDependent: true,
      }),
    );
    expect(theirs).toContain(
      "SUMMARY:HealthBridge: Kamala Rao's visit to Dr. Meera Iyer at Sunrise Family Clinic",
    );
  });

  it('keep one entry per booking chain: a move and a cancellation are later versions', () => {
    const moved = facts({ id: '0192b6f0-0000-7000-8000-00000000eeee', depth: 1 });
    const request = appointmentIcs(moved, { ...options, method: 'REQUEST' });
    const cancel = appointmentIcs(moved, { ...options, method: 'CANCEL' });
    expect(request).toContain('UID:appointment-0192b6f0-0000-7000-8000-00000000abcd@healthbridge');
    expect(request).toContain('SEQUENCE:2');
    expect(cancel).toContain('SEQUENCE:3');
    expect(cancel).toContain('STATUS:CANCELLED');
    expect(cancel).not.toContain('BEGIN:VALARM');
  });
});
