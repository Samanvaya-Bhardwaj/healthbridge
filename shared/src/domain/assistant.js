import { z } from 'zod';
import { DOCTOR_SPECIALTIES, PRACTICE_AREA_CODES } from './doctorSearch.js';

/**
 * Care assistant contracts (M13, ADR-0029).
 *
 * The assistant is a workflow helper: it understands what someone wants to do (find a
 * doctor, see a time), never what is medically wrong. Its server-side memory is the
 * bounded, structured `CareAssistantState` below — never message text.
 */

/** Kinds of doctor the assistant can look for (the backend sends this list to the AI). */
export const ASSISTANT_SPECIALTIES = DOCTOR_SPECIALTIES;

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

/** Search criteria a person can state, change or remove (step 6). */
export const ASSISTANT_CRITERIA = Object.freeze([
  'specialty',
  'areas',
  'city',
  'language',
  'consultationMode',
  'doctorName',
]);
/** Preferences HealthBridge cannot search by; the assistant says so instead of pretending. */
export const ASSISTANT_UNSUPPORTED = Object.freeze([
  'gender',
  'age',
  'fees',
  'ratings',
  'insurance',
  'other',
]);
/** At most this many clarifying questions in a row; then the assistant searches. */
export const ASSISTANT_MAX_CLARIFY_TURNS = 2;
/** The choice that answers "which kind of doctor?" with "any kind". */
export const ASSISTANT_ANY_DOCTOR_CHOICE = 'Any kind of doctor is fine';

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

/**
 * ADR-0038: a tap on a doctor or time the assistant offered. Applied by code without a
 * model call; the AI service accepts only options it offered, the backend only IDs it
 * returned.
 */
export const assistantSelectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('doctor'), doctorId: z.uuid() }).strict(),
  z
    .object({
      kind: z.literal('slot'),
      doctorId: z.uuid(),
      startsAt: z.iso.datetime({ offset: true }),
    })
    .strict(),
]);

/** ADR-0038: the person confirms a proposed booking, with the reason for the visit. */
export const assistantConfirmSchema = z
  .object({
    reason: z.string().trim().min(3, 'Briefly describe the reason for your visit.').max(500),
  })
  .strict();

export const assistantMessageSchema = z
  .object({
    text: z.string().trim().min(1).max(ASSISTANT_MAX_MESSAGE),
    select: assistantSelectionSchema.optional(),
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
    // M13.2: areas of practice (a doctor's listed focus), only those that fit the specialty.
    areas: z.array(z.enum(PRACTICE_AREA_CODES)).max(3).default([]),
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
    // Step 6 (conversational clarification). Bounded, structured, never text:
    // - doctors the person asked not to see again ("show me others"): backend IDs only;
    excludedDoctorIds: z.array(uuid).max(20).default([]),
    // - an open question: which kind of doctor, when several fit and none was named;
    pendingChoice: z
      .object({
        kind: z.literal('specialty'),
        options: z.array(z.enum(ASSISTANT_SPECIALTIES)).min(2).max(3),
      })
      .strict()
      .nullable()
      .default(null),
    // - how many questions in a row (bounded: after the limit, search with what is known);
    clarifyTurns: z.number().int().min(0).max(ASSISTANT_MAX_CLARIFY_TURNS).default(0),
    // - criteria the person said they do not mind ("any city"), so none is inferred again.
    removed: z.array(z.enum(ASSISTANT_CRITERIA)).max(ASSISTANT_CRITERIA.length).default([]),
    // - preferences from the latest message that cannot be searched (answered honestly).
    notices: z.array(z.enum(ASSISTANT_UNSUPPORTED)).max(ASSISTANT_UNSUPPORTED.length).default([]),
    // ADR-0038: booking in the conversation. The doctor the person chose, the time they
    // picked from those offered, and a clock time asked for in words (HH:MM). References
    // and a time only; the proposal itself lives in the backend.
    bookingDoctorId: uuid.nullable().default(null),
    chosenStart: z.iso.datetime({ offset: true }).nullable().default(null),
    requestedTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .nullable()
      .default(null),
  })
  .strict();

/**
 * Possible-emergency wording (ADR-0029). ONE rule, two runtimes: this is a byte-for-byte
 * mirror of `ai-service/app/agents/care_safety.py` (a backend unit test fails if they
 * drift). The backend applies it BEFORE any AI-service call, so a message that may describe
 * an emergency gets the fixed guidance even when the AI service is down, slow or failing;
 * the AI service keeps its own copy as a second line. This is not triage: it only stops
 * the assistant from treating a possible emergency as a booking request.
 */
export const ASSISTANT_EMERGENCY_ALTERNATIVES = Object.freeze([
  'chest pain|pain in (my|the) chest|',
  "(can'?t|cannot|can not|unable to|difficulty|trouble|struggling to) breath(e|ing)?|",
  'short(ness)? of breath|not breathing|',
  'unconscious|passed out|fainted|collapsed|',
  'seizures?|convulsions?|having a fit|',
  'stroke|face (is )?drooping|slurred speech|',
  "(severe|heavy|uncontrolled) bleeding|bleeding (heavily|a lot|won'?t stop)|",
  String.raw`suicid\w*|kill myself|end my life|self[- ]harm|`,
  'overdose|poison(ed|ing)?',
]);

// The two regex engines differ, so the JavaScript pattern adapts to behave like Python's:
// - Python's `\w` and `\b` are Unicode-aware; JavaScript's are ASCII-only, even with the
//   `u` flag. This class is exactly Python's `\w` (compared over every code point,
//   Unicode 16), and every alternative starts and ends with a word character, so the
//   lookarounds behave as Python's `\b(...)\b` does.
// - Python's `re.I` also matches the Turkish dotted İ and dotless ı to i; JavaScript's
//   `iu` does not, so they are mapped to i first (one letter for one: boundaries keep).
const WORD = String.raw`[\p{L}\p{N}_]`;
const EMERGENCY_PATTERN = new RegExp(
  `(?<!${WORD})(${ASSISTANT_EMERGENCY_ALTERNATIVES.join('').replaceAll(String.raw`\w`, WORD)})(?!${WORD})`,
  'iu',
);
const PYTHON_I_FOLDS = /[\u0130\u0131]/g;

export const ASSISTANT_EMERGENCY_MESSAGE =
  'If this might be an emergency, call 112 or 108 now, or go to the nearest emergency ' +
  "department. Don't wait for an online consultation.";

/**
 * Matching normalisation, mirrored exactly from care_safety.py (constants and shared test
 * cases are checked by a backend test): apostrophe look-alikes people type (curly quotes,
 * modifier letter, prime, backtick, acute, fullwidth) become "'", dash look-alikes
 * (hyphens, en and em dashes, minus) become "-", then Unicode NFKC folds compatibility
 * forms (fullwidth letters, no-break spaces), then any run of whitespace becomes one space.
 */
export const ASSISTANT_EMERGENCY_APOSTROPHES = '‘’‛ʼʹ′`´＇';
export const ASSISTANT_EMERGENCY_WHITESPACE = ' \t\n\r\f\v\u0085  ';
export const ASSISTANT_EMERGENCY_DASHES =
  '\u2010\u2011\u2012\u2013\u2014\u2015\u2212\ufe58\ufe63\uff0d';
const APOSTROPHE_LIKE = new RegExp(`[${ASSISTANT_EMERGENCY_APOSTROPHES}]`, 'g');
const DASH_LIKE = new RegExp(`[${ASSISTANT_EMERGENCY_DASHES}]`, 'g');
const SPACES = new RegExp(`[${ASSISTANT_EMERGENCY_WHITESPACE}]+`, 'g');

export function normalizeForEmergencyScreening(text) {
  return text
    .replace(APOSTROPHE_LIKE, "'")
    .replace(DASH_LIKE, '-')
    .normalize('NFKC')
    .replace(SPACES, ' ');
}

/** True when the text may describe an emergency (deterministic; no model involved). */
export function isPossibleAssistantEmergency(text) {
  return (
    typeof text === 'string' &&
    EMERGENCY_PATTERN.test(normalizeForEmergencyScreening(text).replace(PYTHON_I_FOLDS, 'i'))
  );
}
