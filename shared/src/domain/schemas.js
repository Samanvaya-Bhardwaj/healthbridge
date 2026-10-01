/**
 * M2 domain enumerations and validation schemas, shared by frontend forms and backend
 * request validation. Database CHECK constraints mirror these enumerations.
 */

import { z } from 'zod';

// ── Enumerations ─────────────────────────────────────────────────

export const PATIENT_SEX = Object.freeze(['female', 'male', 'intersex', 'unspecified']);

/** How the guardian is related to the dependent ("guardian is the dependent's …"). */
export const GUARDIAN_RELATIONSHIP_TYPES = Object.freeze([
  'parent',
  'child',
  'spouse',
  'sibling',
  'grandparent',
  'grandchild',
  'legal_guardian',
  'caregiver',
  'other_family',
]);
export const GUARDIAN_ACCESS_SCOPES = Object.freeze(['manage', 'view']);

export const CARE_RELATIONSHIP_STATUSES = Object.freeze([
  'invited',
  'pending',
  'active',
  'paused',
  'ended',
]);

export const DOCTOR_VERIFICATION_STATUSES = Object.freeze([
  'unverified',
  'pending',
  'under_review',
  'verified',
  'rejected',
  'suspended',
]);

export const VERIFICATION_DECISIONS = Object.freeze(['verified', 'rejected']);
export const VERIFICATION_REASON_CODES = Object.freeze([
  'credentials_confirmed',
  'registration_not_found',
  'registration_mismatch',
  'documents_insufficient',
  'duplicate_application',
  'registration_lapsed',
  'misconduct_report',
  'other',
]);

export const CLINIC_MEMBER_ROLES = Object.freeze(['CLINIC_ADMIN', 'DOCTOR']);

// ── Field schemas ────────────────────────────────────────────────

const optionalText = (max) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

export const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9][0-9]{6,14}$/, 'Use international format, e.g. +919812345678.');

const optionalPhone = phoneSchema
  .or(z.literal('').transform(() => null))
  .nullable()
  .optional();

/** ISO date (YYYY-MM-DD) not in the future and not before 1900. */
export const dateOfBirthSchema = z.iso
  .date({ error: 'Enter a valid date of birth.' })
  .refine((v) => v >= '1900-01-01', 'Enter a valid date of birth.')
  .refine(
    (v) => v <= new Date().toISOString().slice(0, 10),
    'Date of birth cannot be in the future.',
  );

const addressFields = {
  addressLine: optionalText(200),
  city: optionalText(100),
  state: optionalText(100),
  postalCode: optionalText(12),
  countryCode: z
    .string()
    .trim()
    .regex(/^[A-Z]{2}$/, 'Use a two-letter country code.')
    .optional(),
};

const patientProfileFields = {
  fullName: z.string().trim().min(1, 'Name is required.').max(120),
  preferredName: optionalText(60),
  dateOfBirth: dateOfBirthSchema,
  sex: z.enum(PATIENT_SEX).nullable().optional(),
  phone: optionalPhone,
  ...addressFields,
  preferredLanguage: optionalText(35),
  emergencyContactName: optionalText(120),
  emergencyContactPhone: optionalPhone,
  emergencyContactRelationship: optionalText(40),
};

const emergencyContactComplete = (value) =>
  !value.emergencyContactName === !value.emergencyContactPhone;
const emergencyContactMessage = {
  message: 'Provide both a name and a phone number for the emergency contact.',
  path: ['emergencyContactPhone'],
};

/** Patient profile (no medical information at this stage). */
export const patientProfileSchema = z
  .object(patientProfileFields)
  .strict()
  .refine(emergencyContactComplete, emergencyContactMessage);

export const patientProfileUpdateSchema = z
  .object(patientProfileFields)
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update.');

export const createDependentSchema = z
  .object({
    ...patientProfileFields,
    relationshipType: z.enum(GUARDIAN_RELATIONSHIP_TYPES),
  })
  .strict()
  .refine(emergencyContactComplete, emergencyContactMessage);

// ── Doctors ──────────────────────────────────────────────────────

export const qualificationSchema = z
  .object({
    degree: z.string().trim().min(2).max(80),
    institution: z.string().trim().min(2).max(150),
    year: z.number().int().min(1950).max(2100),
  })
  .strict();

const doctorProfileFields = {
  professionalName: z.string().trim().min(2).max(120),
  registrationNumber: z
    .string()
    .trim()
    .min(3)
    .max(50)
    .regex(/^[A-Za-z0-9/.-]+$/, 'Use letters, digits, "/", "." or "-".')
    .transform((v) => v.toUpperCase()),
  registrationCouncil: z.string().trim().min(2).max(100),
  registrationYear: z.number().int().min(1950).max(2100),
  primarySpecialization: z.string().trim().min(2).max(80),
  additionalSpecializations: z.array(z.string().trim().min(2).max(80)).max(5).optional(),
  qualifications: z.array(qualificationSchema).min(1).max(10),
  yearsOfExperience: z.number().int().min(0).max(70),
  languages: z.array(z.string().trim().min(2).max(35)).max(10).optional(),
  bio: optionalText(1000),
};

export const doctorProfileSchema = z.object(doctorProfileFields).strict();
export const doctorProfileUpdateSchema = z
  .object(doctorProfileFields)
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update.');

/** Fields that identify the practitioner; locked while verified or under review. */
export const DOCTOR_REGISTRATION_FIELDS = Object.freeze([
  'registrationNumber',
  'registrationCouncil',
  'registrationYear',
]);

export const verificationDecisionSchema = z
  .object({
    decision: z.enum(VERIFICATION_DECISIONS),
    reasonCode: z.enum(VERIFICATION_REASON_CODES),
    notes: optionalText(1000),
  })
  .strict()
  .refine((v) => (v.decision === 'verified') === (v.reasonCode === 'credentials_confirmed'), {
    message: 'Use credentials_confirmed only (and always) for approvals.',
    path: ['reasonCode'],
  });

// ── Clinics ──────────────────────────────────────────────────────

export const clinicSchema = z
  .object({
    name: z.string().trim().min(2).max(150),
    registrationNumber: optionalText(60),
    phone: optionalPhone,
    email: z
      .email()
      .max(254)
      .or(z.literal('').transform(() => null))
      .nullable()
      .optional(),
    ...addressFields,
  })
  .strict();

// ── Care relationships ───────────────────────────────────────────

export const careRequestSchema = z
  .object({
    patientId: z.uuid(),
    doctorId: z.uuid(),
    clinicId: z.uuid().optional(),
  })
  .strict();

export const careInvitationSchema = z
  .object({
    email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
    clinicId: z.uuid().optional(),
  })
  .strict();
