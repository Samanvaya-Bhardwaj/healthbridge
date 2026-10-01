import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { loginSchema } from '@healthbridge/shared';
import { Button } from '../../components/ui/Button.jsx';
import { TextField } from '../../components/ui/TextField.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { useAuth } from './authContext.js';
import { authErrorMessage } from './errorMessages.js';
import { AuthCard } from './AuthCard.jsx';

export function LoginPage() {
  const { status, signIn, endedReason } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [formError, setFormError] = useState(null);
  const notice = location.state?.notice;
  const from = location.state?.from?.pathname ?? '/app';

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: location.state?.email ?? '', password: '' },
  });

  if (status === 'authenticated') return <Navigate to={from} replace />;

  const onSubmit = async (values) => {
    setFormError(null);
    try {
      await signIn(values);
      navigate(from, { replace: true });
    } catch (error) {
      setFormError(authErrorMessage(error));
    }
  };

  return (
    <AuthCard
      title="Sign in"
      subtitle="Continue with the doctors you trust."
      footer={
        <>
          New to HealthBridge?{' '}
          <Link to="/register" className="font-medium text-primary hover:text-primary-hover">
            Create an account
          </Link>
        </>
      }
    >
      {notice && (
        <Alert tone="success" className="mb-6">
          {notice}
        </Alert>
      )}
      {!notice && endedReason === 'expired' && (
        <Alert tone="info" className="mb-6">
          Your session has ended. Please sign in again.
        </Alert>
      )}
      {!notice && endedReason === 'signed_out' && (
        <Alert tone="success" className="mb-6">
          You have signed out.
        </Alert>
      )}
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
        <TextField
          label="Password"
          type="password"
          autoComplete="current-password"
          error={errors.password?.message}
          {...register('password')}
        />
        <Button type="submit" className="w-full" disabled={isSubmitting}>
          {isSubmitting ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </AuthCard>
  );
}
