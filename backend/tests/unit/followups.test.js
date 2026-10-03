import { describe, expect, it } from 'vitest';
import {
  FOLLOW_UP_RED_FLAGS,
  evaluateFollowUpResponse,
  followUpResponseSchema,
} from '@healthbridge/shared';
import { renderInbox, renderTemplate } from '../../src/modules/notifications/templates.js';
import {
  inboxLink,
  templateForEvent,
} from '../../src/modules/notifications/notificationService.js';
import { EVENT_ROUTES } from '../../src/core/queue/routing.js';

describe('follow-up escalation rules (deterministic)', () => {
  it('any red flag is urgent, worse needs attention, otherwise answered', () => {
    for (const flag of Object.keys(FOLLOW_UP_RED_FLAGS)) {
      expect(evaluateFollowUpResponse({ overall: 'better', redFlags: [flag] })).toEqual({
        level: 'urgent',
        status: 'urgent',
        reasons: [`red_flag:${flag}`],
      });
    }
    expect(evaluateFollowUpResponse({ overall: 'worse', redFlags: [] }).status).toBe(
      'needs_attention',
    );
    expect(evaluateFollowUpResponse({ overall: 'same' })).toEqual({
      level: 'none',
      status: 'responded',
      reasons: [],
    });
  });

  it('validates the check-in answer', () => {
    expect(followUpResponseSchema.safeParse({ overall: 'better' }).success).toBe(true);
    expect(followUpResponseSchema.safeParse({ overall: 'fine' }).success).toBe(false);
    expect(
      followUpResponseSchema.safeParse({ overall: 'worse', redFlags: ['chest_pain', 'chest_pain'] })
        .success,
    ).toBe(false);
    expect(
      followUpResponseSchema.safeParse({ overall: 'worse', redFlags: ['headache'] }).success,
    ).toBe(false);
  });
});

describe('follow-up notices and inbox', () => {
  const vars = {
    recipientName: 'Dr. Synthetic',
    patientName: 'Asha',
    relationship: 'self',
    doctorName: 'Dr. Synthetic',
  };

  it('maps events to templates', () => {
    expect(templateForEvent('follow_up.reminder_due')).toBe('follow_up_due');
    expect(templateForEvent('follow_up.responded', { level: 'urgent' })).toBe('follow_up_urgent');
    expect(templateForEvent('follow_up.responded', { level: 'attention' })).toBe(
      'follow_up_attention',
    );
    expect(templateForEvent('follow_up.no_response')).toBe('follow_up_attention');
    expect(EVENT_ROUTES['consultation.completed']).toContain('followups');
    expect(EVENT_ROUTES['follow_up.responded']).toEqual(['notifications', 'followups', 'timeline']);
  });

  it('is generic: no symptoms or notes in emails or the inbox', () => {
    for (const template of ['follow_up_due', 'follow_up_attention', 'follow_up_urgent']) {
      const { text } = renderTemplate(template, vars);
      expect(text).not.toMatch(/breath|chest|fever|bleed|note:/i);
      const inbox = renderInbox(template, vars);
      expect(inbox.title.length).toBeGreaterThan(0);
      expect(inbox.body).not.toMatch(/^Hello/);
    }
  });

  it('links to app paths only', () => {
    expect(inboxLink('follow_up_due')).toBe('/app/follow-ups');
    expect(inboxLink('document_available')).toBe('/app/records');
    expect(inboxLink('prescription_available', { appointmentId: 'a1' })).toBe(
      '/app/appointments/a1/consultation',
    );
    expect(inboxLink('appointment_booked', { appointmentId: 'a1' })).toBe('/app/appointments');
  });
});
