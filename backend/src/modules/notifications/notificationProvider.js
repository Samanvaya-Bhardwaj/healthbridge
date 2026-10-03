import nodemailer from 'nodemailer';
import { smtpTransportOptions } from '../../core/mail/smtp.js';
import { renderTemplate } from './templates.js';

/**
 * NotificationProvider port (ADR-0007, ADR-0020).
 *
 * @typedef {{ email: string, phone?: string|null }} Recipient
 * @typedef {object} NotificationProvider
 * @property {string} name
 * @property {(message: { to: string, subject: string, text: string, template: string }) => Promise<void>} sendEmail
 * @property {(message: { to: string, text: string, template: string }) => Promise<void>} sendSMS
 * @property {(recipient: Recipient, vars: import('./templates.js').TemplateVars) => Promise<void>} sendAppointmentReminder
 * @property {(recipient: Recipient, vars: import('./templates.js').TemplateVars) => Promise<void>} sendPaymentConfirmation
 *
 * Logs record template and channel only — never addresses, phone numbers or bodies.
 */

export class NotificationProviderError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'NotificationProviderError';
    this.kind = kind;
  }
}

/** Adds the template-level convenience operations on top of sendEmail. */
function withTemplateOperations(base) {
  const sendTemplate = (template) => async (recipient, vars) => {
    const { subject, text } = renderTemplate(template, vars);
    await base.sendEmail({ to: recipient.email, subject, text, template });
  };
  return {
    ...base,
    sendAppointmentReminder: sendTemplate('appointment_reminder'),
    sendPaymentConfirmation: sendTemplate('payment_confirmed'),
  };
}

/**
 * In-memory provider for development and tests: records messages, sends nothing.
 * `failNext(channel, times)` injects failures.
 * @returns {NotificationProvider & { sent: object[], failNext: Function }}
 */
export function createFakeNotificationProvider({ logger } = {}) {
  const sent = [];
  const failures = { email: 0, sms: 0 };
  const deliver = (channel) => async (message) => {
    if (failures[channel] > 0) {
      failures[channel] -= 1;
      throw new NotificationProviderError('unavailable', `fake ${channel} failure`);
    }
    sent.push({ channel, ...message, at: new Date() });
    logger?.info({ channel, template: message.template }, 'notification recorded (fake)');
  };
  return withTemplateOperations({
    name: 'fake',
    sent,
    failNext(channel, times = 1) {
      failures[channel] += times;
    },
    sendEmail: deliver('email'),
    sendSMS: deliver('sms'),
  });
}

/**
 * Email over SMTP (Mailpit locally; SES or similar via SMTP in production). SMS has no
 * real provider yet (no costs in development): messages are recorded by the fake.
 */
export function createSmtpNotificationProvider({ from, logger, ...mail }) {
  const transport = nodemailer.createTransport(smtpTransportOptions(mail));
  const sms = createFakeNotificationProvider({ logger });
  return withTemplateOperations({
    name: 'smtp',
    async sendEmail({ to, subject, text, template }) {
      try {
        await transport.sendMail({ from, to, subject, text });
      } catch (err) {
        throw new NotificationProviderError(
          'unavailable',
          `smtp send failed: ${err.code ?? err.name}`,
        );
      }
      logger?.info({ channel: 'email', template }, 'notification sent');
    },
    sendSMS: sms.sendSMS,
  });
}

/** @param {ReturnType<typeof import('../../config/index.js').loadConfig>} config */
export function createNotificationProvider(config, { logger } = {}) {
  return config.notifications.emailProvider === 'smtp'
    ? createSmtpNotificationProvider({ ...config.mail, logger })
    : createFakeNotificationProvider({ logger });
}
