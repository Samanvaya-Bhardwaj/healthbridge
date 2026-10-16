import { describe, expect, it } from 'vitest';
import { calendarText, googleCalendarUrl, outlookCalendarUrl } from './calendarLinks.js';

const appointment = {
  id: '0192b6f0-0000-7000-8000-00000000abcd',
  reference: '0000ABCD',
  mode: 'in_clinic',
  startsAt: '2026-10-20T05:00:00Z',
  endsAt: '2026-10-20T05:20:00Z',
  doctor: { professionalName: 'Dr. Meera Iyer' },
  clinic: { name: 'Sunrise Family Clinic' },
};

describe('add to calendar links (step 7+)', () => {
  it('fill Google and Outlook with the visit, never a reason', () => {
    const google = new URL(googleCalendarUrl(appointment));
    expect(google.hostname).toBe('calendar.google.com');
    expect(google.searchParams.get('dates')).toBe('20261020T050000Z/20261020T052000Z');
    expect(google.searchParams.get('text')).toBe(
      'HealthBridge: visit to Dr. Meera Iyer at Sunrise Family Clinic',
    );
    expect(google.searchParams.get('details')).toContain('Booking reference 0000ABCD');
    const outlook = new URL(outlookCalendarUrl(appointment));
    expect(outlook.searchParams.get('startdt')).toBe('2026-10-20T05:00:00.000Z');
  });

  it('read either appointment shape', () => {
    const fromConsultation = calendarText({
      id: appointment.id,
      mode: 'online',
      doctorName: 'Dr. Meera Iyer',
    });
    expect(fromConsultation.title).toBe('HealthBridge: online consultation with Dr. Meera Iyer');
    expect(fromConsultation.reference).toBe('0000ABCD');
  });
});
