/**
 * Nodemailer SMTP options shared by the transactional mailer and the notification
 * provider.
 *   - Local Mailpit (port 1025, TLS not required) is plain SMTP.
 *   - Everywhere else STARTTLS is attempted, and in staging/production it is REQUIRED
 *     (`requireTls`), so credentials and email content never cross the network in clear.
 *   - Port 465 style implicit TLS with SMTP_SECURE=true. Auth only when a user is set.
 * @param {{ smtpHost: string, smtpPort: number, secure?: boolean, requireTls?: boolean, user?: string, password?: string }} mail
 */
export function smtpTransportOptions(mail) {
  const localMailpit = mail.smtpPort === 1025 && !mail.requireTls && !mail.secure;
  return {
    host: mail.smtpHost,
    port: mail.smtpPort,
    secure: Boolean(mail.secure),
    ...(localMailpit ? { ignoreTLS: true } : { requireTLS: Boolean(mail.requireTls) }),
    ...(mail.user ? { auth: { user: mail.user, pass: mail.password } } : {}),
    tls: { minVersion: 'TLSv1.2' },
    connectionTimeout: 5_000,
    greetingTimeout: 5_000,
    socketTimeout: 10_000,
  };
}
