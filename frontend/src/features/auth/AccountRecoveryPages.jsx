import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ACCOUNT_TOKEN_PATTERN, emailSchema, newPasswordSchema } from '@healthbridge/shared';
import { Button } from '../../components/ui/Button.jsx';
import { TextField } from '../../components/ui/TextField.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { AuthCard } from './AuthCard.jsx';
import { applyFieldErrors, authErrorMessage } from './errorMessages.js';
import { requestPasswordReset, resetPassword, verifyEmail } from './authApi.js';

const signInLink = (
  <Link to="/login" className="font-medium text-primary hover:text-primary-hover">
    Back to sign in
  </Link>
);

/**
 * Reads `#token=…` once and removes it from the address bar and history, so the secret
 * is not left in the URL, browser history or a screenshot. Fragments never reach servers.
 */
function useFragmentToken() {
  const [token] = useState(() => {
    const value = new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '';
    if (window.location.hash) {
      window.history.replaceState(window.history.state, '', window.location.pathname);
    }
    return ACCOUNT_TOKEN_PATTERN.test(value) ? value : null;
  });
  return token;
}

export function ForgotPasswordPage() {
  const [sent, setSent] = useState(null);
  const [formError, setFormError] = useState(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(z.object({ email: emailSchema })),
    defaultValues: { email: '' },
  });
  const onSubmit = async ({ email }) => {
    setFormError(null);
    try {
      const payload = await requestPasswordReset(email);
      setSent(payload.data.message);
    } catch (error) {
      setFormError(authErrorMessage(error));
    }
  };
  return (
    <AuthCard
      title="Reset your password"
      subtitle="We will email you a link to choose a new one."
      footer={signInLink}
    >
      {sent ? (
        <Alert tone="success">{sent}</Alert>
      ) : (
        <>
          {formError && (
            <Alert tone="error" className="mb-6">
              {formError}
            </Alert>
          )}
          <form noValidate onSubmit={handleSubmit(onSubmit)} className="space-y-5">
            <TextField
              label="Email"
              type="email"
              autoComplete="email"
              error={errors.email?.message}
              {...register('email')}
            />
            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? 'Sending…' : 'Send reset link'}
            </Button>
          </form>
        </>
      )}
    </AuthCard>
  );
}

const resetFormSchema = z
  .object({ newPassword: newPasswordSchema, confirm: z.string() })
  .refine((v) => v.newPassword === v.confirm, {
    path: ['confirm'],
    message: 'The passwords do not match.',
  });

export function ResetPasswordPage() {
  const token = useFragmentToken();
  const [done, setDone] = useState(false);
  const [formError, setFormError] = useState(null);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(resetFormSchema),
    defaultValues: { newPassword: '', confirm: '' },
  });
  const onSubmit = async ({ newPassword }) => {
    setFormError(null);
    try {
      await resetPassword({ token, newPassword });
      setDone(true);
    } catch (error) {
      if (!applyFieldErrors(error, setError)) setFormError(authErrorMessage(error));
    }
  };

  return (
    <AuthCard title="Choose a new password" footer={signInLink}>
      {!token ? (
        <Alert tone="error">
          This reset link is incomplete. Open the link from the email again, or{' '}
          <Link to="/forgot-password" className="font-medium underline">
            request a new one
          </Link>
          .
        </Alert>
      ) : done ? (
        <Alert tone="success">
          Your password has been changed and you have been signed out everywhere. You can now sign
          in with the new password.
        </Alert>
      ) : (
        <>
          {formError && (
            <Alert tone="error" className="mb-6">
              {formError}{' '}
              <Link to="/forgot-password" className="font-medium underline">
                Request a new link
              </Link>
            </Alert>
          )}
          <form noValidate onSubmit={handleSubmit(onSubmit)} className="space-y-5">
            <TextField
              label="New password"
              type="password"
              autoComplete="new-password"
              hint="At least 12 characters. A short phrase of unrelated words works well."
              error={errors.newPassword?.message}
              {...register('newPassword')}
            />
            <TextField
              label="Confirm new password"
              type="password"
              autoComplete="new-password"
              error={errors.confirm?.message}
              {...register('confirm')}
            />
            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? 'Saving…' : 'Set new password'}
            </Button>
          </form>
        </>
      )}
    </AuthCard>
  );
}

export function VerifyEmailPage() {
  const token = useFragmentToken();
  const [state, setState] = useState(token ? 'verifying' : 'missing');
  const [message, setMessage] = useState(null);
  const started = useRef(false);
  useEffect(() => {
    // Exactly once, even under StrictMode's double effects (the token is single-use).
    if (!token || started.current) return;
    started.current = true;
    verifyEmail(token)
      .then(() => setState('verified'))
      .catch((error) => {
        setMessage(authErrorMessage(error));
        setState('failed');
      });
  }, [token]);

  return (
    <AuthCard title="Confirm your email" footer={signInLink}>
      {state === 'verifying' && <p role="status">Confirming…</p>}
      {state === 'verified' && <Alert tone="success">Thank you — your email is confirmed.</Alert>}
      {state === 'failed' && <Alert tone="error">{message}</Alert>}
      {state === 'missing' && (
        <Alert tone="error">
          This confirmation link is incomplete. Open the link from the email again, or request a new
          one from your account page.
        </Alert>
      )}
    </AuthCard>
  );
}
