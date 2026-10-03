import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { changePasswordSchema, ROLE_LABELS } from '@healthbridge/shared';
import { useAuth } from '../auth/authContext.js';
import * as authApi from '../auth/authApi.js';
import { applyFieldErrors, authErrorMessage } from '../auth/errorMessages.js';
import { Card } from '../../components/ui/Card.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { TextField } from '../../components/ui/TextField.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { Skeleton } from '../../components/ui/Skeleton.jsx';
import { KeyRound } from 'lucide-react';
import { PageHeader } from '../../components/ui/Typography.jsx';

const formatDate = (value) =>
  new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );

const BROWSERS = [
  [/Edg\//, 'Edge'],
  [/Chrome\//, 'Chrome'],
  [/Firefox\//, 'Firefox'],
  [/Safari\//, 'Safari'],
];
const SYSTEMS = [
  [/Windows/, 'Windows'],
  [/Android/, 'Android'],
  [/iPhone|iPad/, 'iOS'],
  [/Mac OS X/, 'macOS'],
  [/Linux/, 'Linux'],
];

function describeDevice(userAgent) {
  if (!userAgent) return 'Unknown device';
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1] ?? 'Browser';
  const os = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1];
  return os ? `${browser} on ${os}` : browser;
}

function SessionsCard() {
  const queryClient = useQueryClient();
  const sessions = useQuery({ queryKey: ['auth', 'sessions'], queryFn: authApi.fetchSessions });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['auth', 'sessions'] });
  const revoke = useMutation({ mutationFn: authApi.revokeSession, onSuccess: invalidate });
  const revokeOthers = useMutation({
    mutationFn: authApi.revokeOtherSessions,
    onSuccess: invalidate,
  });
  const others = sessions.data?.filter((s) => !s.current) ?? [];

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-text">Active sessions</h2>
          <p className="mt-1 text-sm text-text-muted">
            Devices currently signed in to your account.
          </p>
        </div>
        {others.length > 0 && (
          <Button
            variant="secondary"
            onClick={() => revokeOthers.mutate()}
            disabled={revokeOthers.isPending}
          >
            Sign out other sessions
          </Button>
        )}
      </div>
      {sessions.isPending && (
        <div className="mt-6 space-y-3" aria-busy="true">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      )}
      {sessions.isError && (
        <Alert tone="error" className="mt-6">
          {authErrorMessage(sessions.error)}
        </Alert>
      )}
      {sessions.data && (
        <ul className="mt-6 divide-y divide-border">
          {sessions.data.map((session) => (
            <li key={session.id} className="flex flex-wrap items-center justify-between gap-3 py-4">
              <div>
                <p className="text-sm font-medium text-text">
                  {describeDevice(session.userAgent)}
                  {session.current && (
                    <span className="ml-2 rounded-full bg-primary-soft px-2 py-0.5 text-xs text-primary">
                      This device
                    </span>
                  )}
                </p>
                <p className="mt-0.5 text-xs text-text-subtle">
                  Last active {formatDate(session.lastUsedAt)} · signed in{' '}
                  {formatDate(session.createdAt)}
                </p>
              </div>
              {!session.current && (
                <Button
                  variant="ghost"
                  onClick={() => revoke.mutate(session.id)}
                  disabled={revoke.isPending}
                  aria-label={`Sign out ${describeDevice(session.userAgent)}`}
                >
                  Sign out
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ChangePasswordCard() {
  const [result, setResult] = useState(null);
  const queryClient = useQueryClient();
  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: { currentPassword: '', newPassword: '' },
  });

  const onSubmit = async (values) => {
    setResult(null);
    try {
      const response = await authApi.changePassword(values);
      reset();
      queryClient.invalidateQueries({ queryKey: ['auth', 'sessions'] });
      const count = response.data.otherSessionsRevoked;
      const suffix = count ? ` ${count} other session${count === 1 ? '' : 's'} signed out.` : '';
      setResult({ tone: 'success', text: `Password updated.${suffix}` });
    } catch (error) {
      if (!applyFieldErrors(error, setError))
        setResult({ tone: 'error', text: authErrorMessage(error) });
    }
  };

  return (
    <Card>
      <h2 className="text-base font-semibold text-text">Change password</h2>
      <p className="mt-1 text-sm text-text-muted">Other devices will be signed out.</p>
      {result && (
        <Alert tone={result.tone} className="mt-6">
          {result.text}
        </Alert>
      )}
      <form noValidate onSubmit={handleSubmit(onSubmit)} className="mt-6 max-w-md space-y-5">
        <TextField
          label="Current password"
          type="password"
          autoComplete="current-password"
          error={errors.currentPassword?.message}
          {...register('currentPassword')}
        />
        <TextField
          label="New password"
          type="password"
          autoComplete="new-password"
          error={errors.newPassword?.message}
          {...register('newPassword')}
        />
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Updating…' : 'Update password'}
        </Button>
      </form>
    </Card>
  );
}

/** Email confirmation state; the confirmation link is sent by email (M11). */
function EmailStatus() {
  const account = useQuery({ queryKey: ['account'], queryFn: authApi.fetchAccount });
  const resend = useMutation({ mutationFn: authApi.resendEmailVerification });
  if (!account.data) return null;
  if (account.data.emailVerifiedAt) {
    return <p className="mt-1 text-xs text-success">Confirmed</p>;
  }
  return (
    <div className="mt-1 space-y-1">
      <p className="text-xs text-warning">Not confirmed yet</p>
      {resend.data ? (
        <p className="text-xs text-text-muted" role="status">
          {resend.data.status === 'already_verified'
            ? 'Your email is already confirmed.'
            : 'We sent a confirmation link. It works for 24 hours.'}
        </p>
      ) : (
        <Button variant="ghost" disabled={resend.isPending} onClick={() => resend.mutate()}>
          Send confirmation email
        </Button>
      )}
      {resend.isError && <p className="text-xs text-danger">{authErrorMessage(resend.error)}</p>}
    </div>
  );
}

export function AccountPage() {
  const { user } = useAuth();
  return (
    <div className="space-y-6">
      <PageHeader
        icon={KeyRound}
        eyebrow="Account"
        title="Sign-in & security"
        description="Your account details, password, email confirmation and the devices signed in to your account."
      />
      <Card>
        <h2 className="text-base font-semibold text-text">Account</h2>
        <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-text-subtle">Name</dt>
            <dd className="mt-1 font-medium text-text">{user.fullName}</dd>
          </div>
          <div>
            <dt className="text-text-subtle">Email</dt>
            <dd className="mt-1 font-medium text-text">{user.email}</dd>
            <EmailStatus />
          </div>
          <div>
            <dt className="text-text-subtle">Roles</dt>
            <dd className="mt-1 font-medium text-text">
              {user.roles.map((r) => ROLE_LABELS[r]).join(', ')}
            </dd>
          </div>
        </dl>
      </Card>
      <ChangePasswordCard />
      <SessionsCard />
    </div>
  );
}
