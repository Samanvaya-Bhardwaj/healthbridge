/**
 * Validation schemas shared by the frontend (forms) and backend (request validation).
 * The backend additionally applies server-only checks (common-password list, etc.).
 */

import { z } from 'zod';

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
export const FULL_NAME_MAX_LENGTH = 120;
export const EMAIL_MAX_LENGTH = 254;

/** Version of the terms/privacy notice a user accepts at registration. */
export const CURRENT_TERMS_VERSION = '2026-10-01';

export const emailSchema = z
  .string({ error: 'Email is required.' })
  .trim()
  .toLowerCase()
  .max(EMAIL_MAX_LENGTH, 'Email is too long.')
  .pipe(z.email({ error: 'Enter a valid email address.' }));

/** Password policy (NIST SP 800-63B style): length-based, no composition rules. */
export const newPasswordSchema = z
  .string({ error: 'Password is required.' })
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters.`)
  .max(PASSWORD_MAX_LENGTH, `Use at most ${PASSWORD_MAX_LENGTH} characters.`);

export const fullNameSchema = z
  .string({ error: 'Name is required.' })
  .trim()
  .min(1, 'Name is required.')
  .max(FULL_NAME_MAX_LENGTH, 'Name is too long.');

export const registerSchema = z
  .object({
    email: emailSchema,
    password: newPasswordSchema,
    fullName: fullNameSchema,
    acceptTerms: z.literal(true, { error: 'You must accept the terms and privacy notice.' }),
  })
  .strict();

/** Login does not apply the new-password policy (avoids leaking policy, allows rehash). */
export const loginSchema = z
  .object({
    email: z.string().trim().toLowerCase().min(1, 'Email is required.').max(EMAIL_MAX_LENGTH),
    password: z.string().min(1, 'Password is required.').max(PASSWORD_MAX_LENGTH),
  })
  .strict();

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required.').max(PASSWORD_MAX_LENGTH),
    newPassword: newPasswordSchema,
  })
  .strict();

export const updateAccountSchema = z.object({ fullName: fullNameSchema }).strict();
