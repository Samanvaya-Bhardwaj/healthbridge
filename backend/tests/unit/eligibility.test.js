import { describe, expect, it, vi } from 'vitest';
import { appointmentTransition } from '../../src/modules/scheduling/domain/appointmentStateMachine.js';
import { templateForEvent } from '../../src/modules/notifications/notificationService.js';
import { renderTemplate } from '../../src/modules/notifications/templates.js';
import { QUEUE_NAMES } from '../../src/core/queue/queues.js';
import { EVENT_ROUTES } from '../../src/core/queue/routing.js';
import { createJobProcessors } from '../../src/workers/handlers.js';

const DOCTOR = '01a10227-3be6-7744-b9a6-1b48433f85ed';
const CLINIC = '01a10227-3be6-7744-b9a6-1b48433f85ee';
const USER = '01a10227-3be6-7744-b9a6-1b48433f85ef';
const EVENT = '01a10227-3be6-7744-b9a6-1b48433f85f0';

describe('withdrawing bookings that stopped being eligible', () => {
  const future = {
    status: 'confirmed',
    starts_at: new Date(Date.now() + 86_400_000),
    ends_at: new Date(Date.now() + 86_400_000 + 900_000),
    mode: 'online',
  };

  it('the system may cancel an open future booking', () => {
    expect(appointmentTransition(future, 'cancel', 'system')).toBe('cancelled');
    expect(
      appointmentTransition({ ...future, status: 'pending_payment' }, 'cancel', 'system'),
    ).toBe('cancelled');
  });

  it('tells the patient why, and that any payment is refunded in full', () => {
    const payload = { party: 'system', reason: 'clinic_closed' };
    expect(templateForEvent('appointment.cancelled', payload)).toBe('appointment_withdrawn');
    expect(templateForEvent('appointment.cancelled', { party: 'patient' })).toBe(
      'appointment_cancelled',
    );
    expect(templateForEvent('appointment.cancelled', { reason: 'rescheduled' })).toBeNull();
    const { subject, text } = renderTemplate('appointment_withdrawn', {
      recipientName: 'Asha',
      doctorName: 'Dr. Synthetic',
      startsAt: new Date('2026-10-20T05:00:00Z'),
      reference: 'ABC123',
    });
    expect(subject).toMatch(/cancelled/i);
    expect(text).toMatch(/refunded in full/);
    expect(text).toMatch(/book another time/);
  });

  it('routes practice changes to the appointments queue', () => {
    expect(EVENT_ROUTES['practice.changed']).toEqual([QUEUE_NAMES.APPOINTMENTS]);
  });

  describe('the appointments worker', () => {
    const setup = (doctorIdForUser = async () => null) => {
      const appointmentService = { withdrawIneligible: vi.fn(async () => ({ withdrawn: 2 })) };
      const doctorService = { doctorIdForUser: vi.fn(doctorIdForUser) };
      const processors = createJobProcessors(
        {
          appointmentService,
          doctorService,
          notificationService: { sendReminder: vi.fn() },
          paymentProvider: { name: 'fake' },
          config: { payments: {} },
        },
        {},
      );
      return { appointmentService, doctorService, queue: processors[QUEUE_NAMES.APPOINTMENTS] };
    };
    const job = (payload) => ({
      name: 'practice.changed',
      data: {
        eventId: EVENT,
        eventType: 'practice.changed',
        aggregateType: 'clinic',
        aggregateId: CLINIC,
        payload,
      },
    });

    it('withdraws the affected bookings of a doctor and/or clinic', async () => {
      const { appointmentService, queue } = setup();
      const j = job({ doctorId: DOCTOR, clinicId: CLINIC, cause: 'membership_ended' });
      expect(queue.schemas['practice.changed'].safeParse(j.data).success).toBe(true);
      await queue.handle(j);
      expect(appointmentService.withdrawIneligible).toHaveBeenCalledWith({
        doctorId: DOCTOR,
        clinicId: CLINIC,
      });
    });

    it('resolves a disabled account to its doctor; other accounts have nothing to withdraw', async () => {
      const doctor = setup(async () => DOCTOR);
      await doctor.queue.handle(job({ userId: USER, cause: 'account_disabled' }));
      expect(doctor.appointmentService.withdrawIneligible).toHaveBeenCalledWith({
        doctorId: DOCTOR,
        clinicId: undefined,
      });

      const patient = setup(async () => null);
      expect(await patient.queue.handle(job({ userId: USER, cause: 'account_disabled' }))).toEqual({
        withdrawn: 0,
      });
      expect(patient.appointmentService.withdrawIneligible).not.toHaveBeenCalled();
    });

    it('refuses a job without a valid identifier', () => {
      const { queue } = setup();
      const schema = queue.schemas['practice.changed'];
      expect(schema.safeParse(job({ cause: 'clinic_closed' }).data).success).toBe(false);
      expect(schema.safeParse(job({ clinicId: 'not-a-uuid' }).data).success).toBe(false);
    });
  });
});
