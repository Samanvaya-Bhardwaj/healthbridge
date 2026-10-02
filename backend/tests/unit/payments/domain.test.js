import { describe, expect, it } from 'vitest';
import {
  cancellationRefund,
  paymentTransition,
  statusAfterRefund,
} from '../../../src/modules/payments/domain/paymentStateMachine.js';
import { appointmentTransition } from '../../../src/modules/scheduling/domain/appointmentStateMachine.js';
import { ConflictError, ForbiddenError } from '../../../src/core/http/errors.js';
import { templateForEvent } from '../../../src/modules/notifications/notificationService.js';
import { SMS_TEMPLATES, renderTemplate } from '../../../src/modules/notifications/templates.js';
import { isPermanent } from '../../../src/core/queue/workerRuntime.js';
import { failureReason } from '../../../src/core/queue/deadLetters.js';
import { EVENT_ROUTES, outboxJobId } from '../../../src/core/queue/routing.js';
import { PaymentProviderError } from '../../../src/modules/payments/providers/paymentProvider.js';
import { UnrecoverableError } from 'bullmq';

describe('payment state machine', () => {
  it('moves forward on provider events', () => {
    expect(paymentTransition('pending', 'authorized').next).toBe('authorized');
    expect(paymentTransition('authorized', 'captured').next).toBe('paid');
    expect(paymentTransition('pending', 'captured').next).toBe('paid');
    expect(paymentTransition('pending', 'failed').next).toBe('failed');
    expect(paymentTransition('failed', 'captured').next).toBe('paid'); // retry on the same order
    expect(paymentTransition('failed', 'cancel').next).toBe('cancelled');
  });

  it('never moves backwards from a terminal state (stale events are ignored)', () => {
    for (const kind of ['authorized', 'failed', 'captured', 'cancel']) {
      for (const status of ['paid', 'refunded', 'partially_refunded']) {
        expect(paymentTransition(status, kind)).toEqual({ next: null, reason: `stale_${kind}` });
      }
    }
    expect(paymentTransition('cancelled', 'failed').next).toBeNull();
    expect(paymentTransition('cancelled', 'authorized').next).toBeNull();
  });

  it('a capture after cancellation is a late capture (money moved → refund)', () => {
    expect(paymentTransition('cancelled', 'captured')).toEqual({ next: 'paid', lateCapture: true });
  });

  it('refund totals determine refunded vs partially refunded', () => {
    expect(statusAfterRefund(50000, 0)).toBe('paid');
    expect(statusAfterRefund(50000, 20000)).toBe('partially_refunded');
    expect(statusAfterRefund(50000, 50000)).toBe('refunded');
  });

  it('cancellation refund policy', () => {
    const base = {
      refundablePaise: 50000,
      startsAt: '2026-10-10T10:00:00Z',
      cancelledAt: '2026-10-08T10:00:00Z',
    };
    expect(
      cancellationRefund({ ...base, cancelledByParty: 'patient', cancelReason: 'patient_request' })
        .amountPaise,
    ).toBe(50000);
    expect(
      cancellationRefund({
        ...base,
        cancelledAt: '2026-10-10T00:00:00Z',
        cancelledByParty: 'patient',
        cancelReason: 'patient_request',
      }).amountPaise,
    ).toBe(0); // less than 24 hours' notice
    for (const party of ['doctor', 'clinic', 'system']) {
      expect(
        cancellationRefund({
          ...base,
          cancelledAt: '2026-10-10T09:59:00Z',
          cancelledByParty: party,
          cancelReason: 'other',
        }).amountPaise,
      ).toBe(50000);
    }
    expect(
      cancellationRefund({
        ...base,
        cancelledAt: '2026-10-10T09:00:00Z',
        cancelledByParty: 'patient',
        cancelReason: 'rescheduled',
      }),
    ).toEqual({ amountPaise: 50000, reason: 'rescheduled' });
    expect(
      cancellationRefund({ ...base, refundablePaise: 0, cancelledByParty: 'doctor' }).amountPaise,
    ).toBe(0);
  });
});

describe('appointment payment transitions (system only)', () => {
  const appt = (overrides = {}) => ({
    status: 'pending_payment',
    mode: 'online',
    starts_at: new Date('2026-10-10T10:00:00Z'),
    ends_at: new Date('2026-10-10T10:15:00Z'),
    hold_expires_at: new Date('2026-10-08T10:15:00Z'),
    ...overrides,
  });
  const at = (iso) => new Date(iso);

  it('confirm_payment works even just after the hold elapsed (row lock decides)', () => {
    expect(
      appointmentTransition(appt(), 'confirm_payment', 'system', at('2026-10-08T10:16:00Z')),
    ).toBe('confirmed');
    expect(() =>
      appointmentTransition(appt({ status: 'expired' }), 'confirm_payment', 'system'),
    ).toThrow(ConflictError);
    expect(() => appointmentTransition(appt(), 'confirm_payment', 'patient')).toThrow(
      ForbiddenError,
    );
  });

  it('expire only after the hold elapsed, only by the system', () => {
    expect(appointmentTransition(appt(), 'expire', 'system', at('2026-10-08T10:16:00Z'))).toBe(
      'expired',
    );
    expect(() =>
      appointmentTransition(appt(), 'expire', 'system', at('2026-10-08T10:00:00Z')),
    ).toThrow(ConflictError);
    expect(() =>
      appointmentTransition(
        appt({ status: 'confirmed' }),
        'expire',
        'system',
        at('2026-10-09T00:00:00Z'),
      ),
    ).toThrow(ConflictError);
    expect(() =>
      appointmentTransition(appt(), 'expire', 'doctor', at('2026-10-09T00:00:00Z')),
    ).toThrow(ForbiddenError);
  });
});

describe('notifications', () => {
  it('maps events to templates from the event-time payload', () => {
    expect(templateForEvent('appointment.booked', { status: 'confirmed' })).toBe(
      'appointment_booked',
    );
    expect(templateForEvent('appointment.booked', { status: 'pending_payment' })).toBe(
      'payment_required',
    );
    expect(
      templateForEvent('appointment.booked', { status: 'confirmed', rescheduledFromId: 'x' }),
    ).toBe('appointment_rescheduled');
    expect(templateForEvent('appointment.cancelled', { reason: 'rescheduled' })).toBeNull();
    expect(templateForEvent('appointment.cancelled', {})).toBe('appointment_cancelled');
    expect(templateForEvent('payment.captured', { confirmedAppointment: false })).toBeNull();
    expect(templateForEvent('payment.captured', { confirmedAppointment: true })).toBe(
      'payment_confirmed',
    );
    expect(templateForEvent('appointment.checked_in', {})).toBeNull();
  });

  it('templates carry schedule and payment details, never clinical content', () => {
    const vars = {
      recipientName: 'Asha',
      patientName: 'Kabir',
      relationship: 'guardian',
      doctorName: 'Dr. Meera Iyer',
      clinicName: 'Synthetic Clinic',
      mode: 'in_clinic',
      startsAt: '2026-10-10T04:30:00Z',
      timezone: 'Asia/Kolkata',
      reference: 'ABCD1234',
      amountPaise: 50000,
      currency: 'INR',
      offsetMinutes: 1440,
      reason: 'Synthetic: chest pain', // must never be rendered even if passed
    };
    const out = renderTemplate('appointment_reminder', vars);
    expect(out.subject).toBe('Reminder: appointment in 1 day');
    expect(out.text).toContain("Kabir's upcoming appointment");
    expect(out.text).toContain('Sat 10 Oct 2026, 10:00 AM');
    expect(out.text).toContain('In person at Synthetic Clinic');
    expect(out.text).not.toMatch(/chest pain/);
    expect(renderTemplate('payment_confirmed', vars).text).toContain('₹500.00');
    expect(SMS_TEMPLATES).toEqual(
      expect.arrayContaining(['appointment_reminder', 'payment_confirmed']),
    );
  });
});

describe('queues and failure handling', () => {
  it('classifies permanent vs retryable failures', () => {
    expect(isPermanent(new UnrecoverableError('bad'))).toBe(true);
    expect(isPermanent(new ConflictError('x'))).toBe(true);
    expect(isPermanent(new PaymentProviderError('rejected', 'no'))).toBe(true);
    expect(isPermanent(new PaymentProviderError('timeout', 'slow'))).toBe(false);
    expect(isPermanent(new PaymentProviderError('unavailable', '5xx'))).toBe(false);
    expect(
      isPermanent(Object.assign(new Error('connection terminated'), { code: 'ECONNRESET' })),
    ).toBe(false);
  });

  it('failure reasons are bounded and carry no stack', () => {
    const reason = failureReason(Object.assign(new Error('x'.repeat(2000)), { kind: 'timeout' }));
    expect(reason.length).toBe(500);
    expect(reason).toMatch(/^Error: \[timeout\] x+/);
    expect(reason).not.toMatch(/at .*\.js/);
  });

  it('routes financial events to payments and people-facing ones to notifications', () => {
    expect(EVENT_ROUTES['appointment.cancelled']).toEqual(['payments', 'notifications']);
    expect(EVENT_ROUTES['payment.refund_requested']).toEqual(['payments']);
    expect(outboxJobId('payments', 'e1')).toBe('payments-e1');
    expect(outboxJobId('payments', 'e1')).not.toContain(':');
  });
});
