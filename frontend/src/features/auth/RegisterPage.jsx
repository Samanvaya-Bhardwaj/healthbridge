import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { PASSWORD_MIN_LENGTH, registerSchema } from '@healthbridge/shared';
import { Button } from '../../components/ui/Button.jsx';
import { TextField } from '../../components/ui/TextField.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { useAuth } from './authContext.js';
import { register as registerAccount } from './authApi.js';
import { applyFieldErrors, authErrorMessage } from './errorMessages.js';
import { AuthCard } from './AuthCard.jsx';

export function RegisterPage() {
  const { status } = useAuth();
  const navigate = useNavigate();
  const [formError, setFormError] = useState(null);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(registerSchema),
    defaultValues: { fullName: '', email: '', password: '', acceptTerms: false },
  });

  if (status === 'authenticated') return <Navigate to="/app" replace />;

  const onSubmit = async (values) => {
    setFormError(null);
    try {
      const result = await registerAccount(values);
      // The server responds identically for new and existing emails (no enumeration).
      navigate('/login', { state: { notice: result.data.message, email: values.email } });
    } catch (error) {
      if (!applyFieldErrors(error, setError)) setFormError(authErrorMessage(error));
    }
  };

  return (
    <AuthCard
      title="Create your account"
      subtitle="Keep your care connected with doctors who already know you."
      footer={
        <>
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-primary hover:text-primary-hover">
            Sign in
          </Link>
        </>
      }
    >
      {formError && (
        <Alert tone="error" className="mb-6">
          {formError}
        </Alert>
      )}
      <form noValidate onSubmit={handleSubmit(onSubmit)} className="space-y-5">
        <TextField
          label="Full name"
          autoComplete="name"
          error={errors.fullName?.message}
          {...register('fullName')}
        />
        <TextField
          label="Email"
          type="email"
          autoComplete="email"
          error={errors.email?.message}
          {...register('email')}
        />
        <TextField
          label="Password"
          type="password"
          autoComplete="new-password"
          hint={`At least ${PASSWORD_MIN_LENGTH} characters. A short phrase of unrelated words works well.`}
          error={errors.password?.message}
          {...register('password')}
        />
        <div>
          <label className="flex items-start gap-3 text-sm text-text-muted">
            <input
              type="checkbox"
              className="mt-0.5 h-5 w-5 rounded border-border accent-primary"
              aria-invalid={errors.acceptTerms ? 'true' : undefined}
              {...register('acceptTerms')}
            />
            <span>
              I agree to the Terms of Use and Privacy Notice, and understand that HealthBridge
              shares my records with doctors only with my consent.
            </span>
          </label>
          {errors.acceptTerms && (
            <p className="mt-1.5 text-sm text-danger">{errors.acceptTerms.message}</p>
          )}
        </div>
        <Button type="submit" className="w-full" disabled={isSubmitting}>
          {isSubmitting ? 'Creating account…' : 'Create account'}
        </Button>
      </form>
    </AuthCard>
  );
}
