import { z } from 'zod';

/**
 * Care assistant contracts (M13, ADR-0029).
 *
 * The assistant is a workflow helper: it understands what someone wants to do (find a
 * doctor, see a time), never what is medically wrong. Its server-side memory is the
 * bounded, structured `CareAssistantState` below — never message text.
 */

/** Kinds of doctor the assistant can look for (the backend sends this list to the AI). */
export const ASSISTANT_SPECIALTIES = Object.freeze([
  'General Medicine',
  'Family Medicine',
  'Dermatology',
  'Paediatrics',
  'Gynaecology',
  'Cardiology',
  'Orthopaedics',
  'ENT',
  'Ophthalmology',
  'Psychiatry',
  'Neurology',
  'Gastroenterology',
  'Endocrinology',
  'Pulmonology',
]);

export const ASSISTANT_INTENTS = Object.freeze([
  'find_doctor',
  'book_appointment',
  'view_appointments',
  'reschedule',
  'cancel',
  'ask_records',
  'view_medications',
  'greeting',
  'unsupported',
]);

export const ASSISTANT_TIME_WINDOWS = Object.freeze(['morning', 'afternoon', 'evening']);

/** Read-only tools available in M13.1 (the backend's allow-list is authoritative). */
export const ASSISTANT_TOOLS = Object.freeze([
  'getPatientContext',
  'getPatientCareTeam',
  'searchDoctors',
  'getDoctorProfile',
  'findAvailableSlots',
]);

export const ASSISTANT_MAX_MESSAGE = 500;

const timeZone = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$/,
    'Use an IANA time zone, for example Asia/Kolkata.',
  );

export const assistantSessionCreateSchema = z
  .object({
    // Omitted: the signed-in patient. Otherwise a dependent the user manages.
    patientId: z.uuid().optional(),
  })
  .strict();

export const assistantMessageSchema = z
  .object({
    text: z.string().trim().min(1).max(ASSISTANT_MAX_MESSAGE),
    // Optimistic concurrency: the session version the browser last saw.
    version: z.number().int().min(1),
    timeZone: timeZone.default('Asia/Kolkata'),
  })
  .strict();

const isoDay = z.iso.date();
const uuid = z.uuid();

export const assistantCriteriaSchema = z
  .object({
    specialty: z.enum(ASSISTANT_SPECIALTIES).nullable().default(null),
    consultationMode: z.enum(['online', 'in_clinic']).nullable().default(null),
    // A calendar day the backend resolved in the user's time zone.
    date: isoDay.nullable().default(null),
    timeWindow: z.enum(ASSISTANT_TIME_WINDOWS).nullable().default(null),
    language: z
      .string()
      .regex(/^[A-Za-z][A-Za-z ]{1,29}$/)
      .nullable()
      .default(null),
    city: z
      .string()
      .regex(/^[A-Za-z][A-Za-z .'-]{1,39}$/)
      .nullable()
      .default(null),
    doctorName: z
      .string()
      .regex(/^[A-Za-z][A-Za-z .'-]{1,59}$/)
      .nullable()
      .default(null),
  })
  .strict();

/**
 * What the server remembers between turns: what the person is trying to do, the
 * non-diagnostic search criteria, and references (IDs) to doctors and slots that the
 * backend itself returned. Bounded so it can never grow into a transcript.
 */
export const careAssistantStateSchema = z
  .object({
    v: z.literal(1).default(1),
    intent: z.enum(ASSISTANT_INTENTS).nullable().default(null),
    criteria: assistantCriteriaSchema.prefault({}),
    // The kind of doctor was inferred from a described concern; a flag, never the concern.
    specialtyFromConcern: z.boolean().default(false),
    careTeamDoctorIds: z.array(uuid).max(20).default([]),
    candidateDoctorIds: z.array(uuid).max(5).default([]),
    selectedDoctorId: uuid.nullable().default(null),
    slotStarts: z
      .array(z.iso.datetime({ offset: true }))
      .max(6)
      .default([]),
    lastTools: z.array(z.enum(ASSISTANT_TOOLS)).max(6).default([]),
  })
  .strict();
