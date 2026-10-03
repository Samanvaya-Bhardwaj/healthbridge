import nodemailer from 'nodemailer';
import { smtpTransportOptions } from './smtp.js';

/**
 * Minimal transactional-email port (the full notification service arrives in M10).
 * Logs record the template only: recipient addresses and bodies are never logged.
 *
 * @typedef {{ to: string, subject: string, text: string, template: string }} MailMessage
 * @typedef {{ send: (message: MailMessage) => Promise<void> }} Mailer
 */

/** SMTP mailer (Mailpit locally; a provider such as SES via SMTP in production). */
export function createSmtpMailer({ from, logger, ...mail }) {
  const transport = nodemailer.createTransport(smtpTransportOptions(mail));
  return {
    async send({ to, subject, text, template }) {
      await transport.sendMail({ from, to, subject, text });
      logger.info({ template }, 'email sent');
    },
  };
}

/** Used when SMTP is not configured: drops the message and records that it did. */
export function createNoopMailer({ logger }) {
  return {
    async send({ template }) {
      logger.warn({ template }, 'email not sent: SMTP not configured');
    },
  };
}

/** In-memory mailer for tests. */
export function createMemoryMailer() {
  const sent = [];
  return {
    sent,
    async send(message) {
      sent.push(message);
    },
  };
}
