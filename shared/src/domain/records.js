/** M5 consent and medical-document enumerations and schemas (ADR-0021). */

import { z } from 'zod';

// ── Consent ─────────────────────────────────────────────────────────

/**
 * What a consent covers. A consent never means "everything": each scope is explicit.
 *   patient_profile           the patient's profile (demographics, contacts)
 *   medical_documents         view and download AVAILABLE medical documents
 *   medical_documents_upload  add documents to the patient's record (treating doctor)
 */
export const CONSENT_SCOPES = Object.freeze([
  'patient_profile',
  'medical_documents',
  'medical_documents_upload',
]);
/** manual: ongoing access until expiry; appointment: tied to one consultation. */
export const CONSENT_KINDS = Object.freeze(['manual', 'appointment']);
export const CONSENT_PURPOSES = Object.freeze([
  'consultation',
  'ongoing_care',
  'second_opinion',
  'follow_up',
]);
/** Stored lifecycle. A consent past `expiresAt` is treated as expired at request time
 * even before the housekeeping job records the `expired` status. */
export const CONSENT_STATUSES = Object.freeze(['active', 'revoked', 'expired']);
export const CONSENT_REVOKE_REASONS = Object.freeze([
  'no_longer_needed',
  'changed_doctor',
  'privacy',
  'other',
]);
export const MAX_CONSENT_DAYS = 365;
/** Appointment-scoped consent lasts until this long after the consultation ends. */
export const APPOINTMENT_CONSENT_GRACE_HOURS = 72;

// ── Medical documents ───────────────────────────────────────────────

export const DOCUMENT_TYPES = Object.freeze([
  'lab_report',
  'prescription',
  'imaging',
  'discharge_summary',
  'other',
]);
/**
 * pending_upload → quarantined → scanning → available
 *                                         ↘ rejected
 * available | rejected → retired (record kept; never destructively deleted)
 */
export const DOCUMENT_STATUSES = Object.freeze([
  'pending_upload',
  'quarantined',
  'scanning',
  'available',
  'rejected',
  'retired',
]);
export const DOCUMENT_REJECTION_REASONS = Object.freeze([
  'infected',
  'unsupported_content',
  'type_mismatch',
  'size_exceeded',
  'size_mismatch',
  'checksum_mismatch',
  'upload_missing',
  'upload_expired',
]);

/** Deliberately small allowlist: content type → permitted file extensions. */
export const DOCUMENT_CONTENT_TYPES = Object.freeze({
  'application/pdf': Object.freeze(['pdf']),
  'image/png': Object.freeze(['png']),
  'image/jpeg': Object.freeze(['jpg', 'jpeg']),
});
/** Absolute ceiling; the server's configured maximum (DOCUMENT_MAX_BYTES) is lower. */
export const DOCUMENT_HARD_MAX_BYTES = 25 * 1024 * 1024;

const extensionOf = (name) => {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return match ? match[1].toLowerCase() : null;
};

// Display names: no control characters, no path separators.
const isSafeDisplayName = (v) =>
  [...v].every((ch) => {
    const code = ch.codePointAt(0);
    return code >= 0x20 && code !== 0x7f && ch !== '/' && code !== 0x5c; // 0x5c = backslash
  });
const displayName = (max) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine(isSafeDisplayName, 'Use letters, numbers and punctuation only.');

export const uploadIntentSchema = z
  .object({
    documentType: z.enum(DOCUMENT_TYPES),
    title: displayName(120),
    filename: displayName(200),
    contentType: z.enum(Object.keys(DOCUMENT_CONTENT_TYPES)),
    sizeBytes: z.number().int().positive().max(DOCUMENT_HARD_MAX_BYTES),
    sha256: z.string().regex(/^[0-9a-f]{64}$/, 'SHA-256 as 64 lower-case hex characters.'),
  })
  .strict()
  .refine((v) => DOCUMENT_CONTENT_TYPES[v.contentType].includes(extensionOf(v.filename) ?? ''), {
    message: 'The file extension does not match the file type.',
    path: ['filename'],
  });

export const grantConsentSchema = z
  .object({
    patientId: z.uuid(),
    doctorId: z.uuid(),
    kind: z.enum(CONSENT_KINDS),
    appointmentId: z.uuid().optional(),
    scopes: z
      .array(z.enum(CONSENT_SCOPES))
      .min(1)
      .max(CONSENT_SCOPES.length)
      .refine((s) => new Set(s).size === s.length, 'Each scope only once.'),
    /** Limit document access to these types; omit for all types. */
    documentTypes: z
      .array(z.enum(DOCUMENT_TYPES))
      .min(1)
      .max(DOCUMENT_TYPES.length)
      .refine((s) => new Set(s).size === s.length, 'Each type only once.')
      .optional(),
    purpose: z.enum(CONSENT_PURPOSES),
    expiresInDays: z.number().int().min(1).max(MAX_CONSENT_DAYS).optional(),
  })
  .strict()
  .refine((v) => (v.kind === 'appointment') === Boolean(v.appointmentId), {
    message: 'Appointment consents need an appointment; manual consents must not have one.',
    path: ['appointmentId'],
  })
  .refine((v) => v.kind !== 'manual' || v.expiresInDays, {
    message: 'Choose how long this access lasts.',
    path: ['expiresInDays'],
  });

export const revokeConsentSchema = z
  .object({ reasonCode: z.enum(CONSENT_REVOKE_REASONS).default('no_longer_needed') })
  .strict();
