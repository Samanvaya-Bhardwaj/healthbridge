import { NOTIFICATION_TEMPLATES, formatPaise } from '@healthbridge/shared';
import { DateTime } from 'luxon';

/**
 * Notification templates. Content is scheduling and payment information only — never the
 * reason for visit or any other clinical content. Each template renders an email
 * (subject + text) and, where useful, a short SMS.
 *
 * @typedef {object} TemplateVars
 * @property {string} recipientName
 * @property {string} patientName
 * @property {'self'|'guardian'} relationship
 * @property {string} doctorName
 * @property {string|null} clinicName
 * @property {'online'|'in_clinic'} mode
 * @property {Date|string} startsAt
 * @property {string} timezone
 * @property {string} reference
 * @property {number} [amountPaise]
 * @property {string} [currency]
 * @property {number} [offsetMinutes]
 */

const when = (v) =>
  DateTime.fromJSDate(new Date(v.startsAt))
    .setZone(v.timezone || 'Asia/Kolkata')
    .toFormat("ccc d LLL yyyy, h:mm a '('ZZZZ')'");
const where = (v) =>
  v.mode === 'online' ? 'Online consultation' : `In person at ${v.clinicName ?? 'the clinic'}`;
const whose = (v) => (v.relationship === 'guardian' ? `${v.patientName}'s` : 'Your');
/** Mid-sentence form: "your", or the patient's name unchanged (never lower-cased). */
const whoseInline = (v) => (v.relationship === 'guardian' ? `${v.patientName}'s` : 'your');
const money = (v) => formatPaise(v.amountPaise ?? 0, v.currency ?? 'INR');
const lead = (minutes) =>
  minutes >= 1440 && minutes % 1440 === 0
    ? `${minutes / 1440} day${minutes === 1440 ? '' : 's'}`
    : minutes >= 60 && minutes % 60 === 0
      ? `${minutes / 60} hour${minutes === 60 ? '' : 's'}`
      : `${minutes} minutes`;

const details = (v) =>
  [
    `Doctor: ${v.doctorName}`,
    `When: ${when(v)}`,
    `Where: ${where(v)}`,
    `Booking reference: ${v.reference}`,
  ].join('\n');

const footer =
  '\n\nThis is an automated message from HealthBridge. Please do not reply.\n' +
  'Manage your appointments in the HealthBridge app.';

const TEMPLATES = {
  appointment_booked: (v) => ({
    subject: `Appointment confirmed with ${v.doctorName}`,
    text: `Hello ${v.recipientName},\n\n${whose(v)} appointment is confirmed.\n\n${details(v)}`,
    sms: `HealthBridge: ${whose(v)} appointment with ${v.doctorName} on ${when(v)} is confirmed. Ref ${v.reference}.`,
  }),
  payment_required: (v) => ({
    subject: `Complete payment to confirm your appointment`,
    text:
      `Hello ${v.recipientName},\n\n${whose(v)} appointment is reserved and will be confirmed ` +
      `once the payment of ${money(v)} is received. The reservation is held for a short time.\n\n${details(v)}`,
  }),
  payment_confirmed: (v) => ({
    subject: `Payment received – appointment confirmed`,
    text:
      `Hello ${v.recipientName},\n\nWe received your payment of ${money(v)}. ` +
      `${whose(v)} appointment is confirmed.\n\n${details(v)}`,
    sms: `HealthBridge: payment of ${money(v)} received. Appointment on ${when(v)} confirmed. Ref ${v.reference}.`,
  }),
  payment_failed: (v) => ({
    subject: `Payment unsuccessful`,
    text:
      `Hello ${v.recipientName},\n\nThe payment for ${whoseInline(v)} appointment did not go through. ` +
      `No money was taken for this attempt. You can try again while the reservation is held.\n\n${details(v)}`,
  }),
  appointment_cancelled: (v) => ({
    subject: `Appointment cancelled`,
    text: `Hello ${v.recipientName},\n\n${whose(v)} appointment has been cancelled.\n\n${details(v)}`,
    sms: `HealthBridge: ${whoseInline(v)} appointment with ${v.doctorName} on ${when(v)} was cancelled. Ref ${v.reference}.`,
  }),
  appointment_rescheduled: (v) => ({
    subject: `Appointment rescheduled`,
    text: `Hello ${v.recipientName},\n\n${whose(v)} appointment has been moved to a new time.\n\n${details(v)}`,
  }),
  appointment_expired: (v) => ({
    subject: `Reservation expired`,
    text:
      `Hello ${v.recipientName},\n\nThe reservation for ${whoseInline(v)} appointment expired ` +
      `because payment was not completed in time. You can book a new slot in the app.\n\n${details(v)}`,
  }),
  appointment_reminder: (v) => ({
    subject: `Reminder: appointment in ${lead(v.offsetMinutes ?? 60)}`,
    text: `Hello ${v.recipientName},\n\nThis is a reminder of ${whoseInline(v)} upcoming appointment.\n\n${details(v)}`,
    sms: `HealthBridge reminder: ${whoseInline(v)} appointment with ${v.doctorName} on ${when(v)}. Ref ${v.reference}.`,
  }),
  // M5: generic wording — never the document's name, type or content.
  document_available: (v) => ({
    subject: 'Your document is ready',
    text:
      `Hello ${v.recipientName},\n\nA document uploaded to ${whoseInline(v)} health record ` +
      'has passed its safety check and is now available in the app.',
  }),
  document_rejected: (v) => ({
    subject: 'A document could not be added',
    text:
      `Hello ${v.recipientName},\n\nA document uploaded to ${whoseInline(v)} health record ` +
      'could not be accepted. Please open the app for details and try again.',
  }),
  // M9: generic wording — never medicines, note content or diagnoses.
  prescription_available: (v) => ({
    subject: `New prescription from ${v.doctorName}`,
    text:
      `Hello ${v.recipientName},\n\n${v.doctorName} has issued a prescription for ` +
      `${whoseInline(v)} consultation. Open the HealthBridge app to view or download it.\n\n${details(v)}`,
    sms: `HealthBridge: ${v.doctorName} issued a prescription. View it in the app. Ref ${v.reference}.`,
  }),
  in_person_visit_requested: (v) => ({
    subject: `${v.doctorName} has asked for an in-person visit`,
    text:
      `Hello ${v.recipientName},\n\nAfter ${whoseInline(v)} online consultation, ${v.doctorName} ` +
      'would like to examine the patient in person. Please book an in-clinic visit in the app.' +
      `\n\n${details(v)}`,
    sms: `HealthBridge: ${v.doctorName} asked for an in-person visit. Please book in the app. Ref ${v.reference}.`,
  }),
  emergency_guidance: (v) => ({
    subject: 'Urgent: your doctor advised emergency care',
    text:
      `Hello ${v.recipientName},\n\nDuring ${whoseInline(v)} consultation, ${v.doctorName} ` +
      'advised emergency care.\n\nCall 112 (India emergency number) or 108 for an ambulance, ' +
      'or go to the nearest emergency department immediately. Do not wait for a reply in the app.',
    sms: 'HealthBridge URGENT: your doctor advised emergency care. Call 112 or 108, or go to the nearest emergency department now.',
  }),
  // M10: follow-ups — generic wording; never symptoms, warning signs or the patient's note.
  follow_up_due: (v) => ({
    subject: `Follow-up check-in from ${v.doctorName}`,
    text:
      `Hello ${v.recipientName},\n\n${v.doctorName} would like to know how ` +
      `${v.relationship === 'guardian' ? v.patientName : 'you'} ${v.relationship === 'guardian' ? 'is' : 'are'} doing. ` +
      'Please answer the short check-in in the HealthBridge app.\n\n' +
      'If you have severe symptoms, do not wait: call 112 or go to the nearest emergency department.',
    sms: `HealthBridge: ${v.doctorName} sent a follow-up check-in. Please answer it in the app.`,
  }),
  follow_up_attention: (v) => ({
    subject: `A follow-up check-in needs your review`,
    text:
      `Hello ${v.recipientName},\n\nThe follow-up check-in for ${v.patientName} needs your ` +
      'attention. Open HealthBridge to review it.',
  }),
  follow_up_urgent: (v) => ({
    subject: `Urgent: follow-up check-in for ${v.patientName}`,
    text:
      `Hello ${v.recipientName},\n\n${v.patientName} reported a warning sign in a follow-up ` +
      'check-in and was shown emergency guidance. Please review it in HealthBridge now.',
    sms: `HealthBridge URGENT: ${v.patientName} reported a warning sign in a follow-up check-in. Please review now.`,
  }),
  payment_refunded: (v) => ({
    subject: `Refund processed`,
    text:
      `Hello ${v.recipientName},\n\nA refund of ${money(v)} for ${whoseInline(v)} appointment ` +
      `has been processed. It can take a few working days to reach your account.\n\n${details(v)}`,
  }),
};

if (Object.keys(TEMPLATES).sort().join() !== [...NOTIFICATION_TEMPLATES].sort().join()) {
  throw new Error('notification templates and NOTIFICATION_TEMPLATES differ');
}

/**
 * @param {string} template
 * @param {TemplateVars} vars
 * @returns {{ subject: string, text: string, sms?: string }}
 */
export function renderTemplate(template, vars) {
  const render = TEMPLATES[template];
  if (!render) throw new Error(`unknown notification template ${template}`);
  const out = render(vars);
  return { ...out, text: `${out.text}${footer}` };
}

/** Templates also sent by SMS when the recipient has a phone number. */
export const SMS_TEMPLATES = Object.freeze(
  Object.entries(TEMPLATES)
    .filter(([, render]) =>
      Boolean(
        render({
          recipientName: '',
          patientName: '',
          relationship: 'self',
          doctorName: '',
          clinicName: null,
          mode: 'online',
          startsAt: new Date(0),
          timezone: 'UTC',
          reference: '',
        }).sms,
      ),
    )
    .map(([name]) => name),
);

/**
 * Inbox entry for a rendered template: the subject and the first paragraph after the
 * greeting (templates are generic, so the inbox carries no clinical content either).
 * @returns {{ title: string, body: string }}
 */
export function renderInbox(template, vars) {
  const { subject, text } = renderTemplate(template, vars);
  const paragraphs = text.split('\n\n');
  const body = (paragraphs[0].startsWith('Hello ') ? paragraphs[1] : paragraphs[0]) ?? '';
  return { title: subject.slice(0, 160), body: body.replace(/\s+/g, ' ').trim().slice(0, 600) };
}
