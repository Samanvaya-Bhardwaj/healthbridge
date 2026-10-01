/** M3 scheduling enumerations and schemas shared by frontend and backend. */

import { z } from 'zod';

export const CONSULTATION_MODES = Object.freeze(['online', 'in_clinic']);
export const APPOINTMENT_STATUSES = Object.freeze([
  'pending_payment',
  'confirmed',
  'checked_in',
  'in_consultation',
  'completed',
  'cancelled',
  'no_show',
  'expired',
]);
/** Statuses that occupy the doctor's (and patient's) time. */
export const ACTIVE_APPOINTMENT_STATUSES = Object.freeze([
  'pending_payment',
  'confirmed',
  'checked_in',
  'in_consultation',
]);
export const CANCEL_REASONS = Object.freeze([
  'patient_request',
  'doctor_unavailable',
  'clinic_closed',
  'duplicate',
  'other',
]);
export const TIME_OFF_REASONS = Object.freeze([
  'leave',
  'conference',
  'personal',
  'clinic_closed',
  'other',
]);

/** Booking rules. */
export const BOOKING_LEAD_MINUTES = 30;
export const BOOKING_HORIZON_DAYS = 60;
export const PAYMENT_HOLD_MINUTES = 15;

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:MM.');
const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export const availabilityRuleSchema = z
  .object({
    mode: z.enum(CONSULTATION_MODES),
    clinicId: z.uuid().optional(),
    weekday: z.number().int().min(1).max(7),
    startTime: time,
    endTime: time,
    slotMinutes: z.number().int().min(10).max(120),
    timezone: z.string().min(3).max(64).default('Asia/Kolkata'),
    validFrom: z.iso.date(),
    validUntil: z.iso.date().nullable().optional(),
    feePaise: z.number().int().min(0).max(10_000_000).default(0),
  })
  .strict()
  .refine((v) => v.mode !== 'in_clinic' || v.clinicId, {
    message: 'In-clinic availability needs a clinic.',
    path: ['clinicId'],
  })
  .refine((v) => toMinutes(v.endTime) - toMinutes(v.startTime) >= v.slotMinutes, {
    message: 'The window must fit at least one slot.',
    path: ['endTime'],
  })
  .refine((v) => !v.validUntil || v.validUntil >= v.validFrom, {
    message: 'End date must be after the start date.',
    path: ['validUntil'],
  });

export const timeOffSchema = z
  .object({
    startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }),
    reasonCode: z.enum(TIME_OFF_REASONS),
  })
  .strict()
  .refine((v) => new Date(v.endsAt) > new Date(v.startsAt), {
    message: 'End must be after start.',
    path: ['endsAt'],
  });

export const slotQuerySchema = z
  .object({
    from: z.iso.date(),
    to: z.iso.date(),
    mode: z.enum(CONSULTATION_MODES).optional(),
    clinicId: z.uuid().optional(),
  })
  .strict();

export const bookAppointmentSchema = z
  .object({
    patientId: z.uuid(),
    doctorId: z.uuid(),
    startsAt: z.iso.datetime({ offset: true }),
    mode: z.enum(CONSULTATION_MODES),
    clinicId: z.uuid().optional(),
    reason: z.string().trim().min(3, 'Briefly describe the reason for your visit.').max(500),
  })
  .strict();

export const cancelAppointmentSchema = z.object({ reasonCode: z.enum(CANCEL_REASONS) }).strict();

export const rescheduleAppointmentSchema = z
  .object({ startsAt: z.iso.datetime({ offset: true }) })
  .strict();
