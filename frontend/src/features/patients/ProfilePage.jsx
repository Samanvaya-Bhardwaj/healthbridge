import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { GUARDIAN_RELATIONSHIP_TYPES, createDependentSchema } from '@healthbridge/shared';
import { patientsApi } from '../../lib/domainApi.js';
import { ApiError } from '../../lib/apiClient.js';
import { applyFieldErrors, authErrorMessage } from '../auth/errorMessages.js';
import { Card } from '../../components/ui/Card.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { Button, ButtonLink } from '../../components/ui/Button.jsx';
import { SelectField } from '../../components/ui/SelectField.jsx';
import { Skeleton } from '../../components/ui/Skeleton.jsx';
import { PatientProfileForm } from './PatientProfileForm.jsx';
import { useAuth } from '../auth/authContext.js';
import { Stethoscope, UserRound } from 'lucide-react';
import { PageHeader } from '../../components/ui/Typography.jsx';
import { useConfirm } from '../../components/ui/useConfirm.jsx';
import { useSafeMutation } from '../../lib/useSafeMutation.js';

const RELATIONSHIP_OPTIONS = GUARDIAN_RELATIONSHIP_TYPES.map((v) => ({
  value: v,
  label: `I am their ${v.replace('_', ' ')}`,
}));

function useSave(mutationFn, onDone) {
  const [message, setMessage] = useState(null);
  const submit = async (values, setError) => {
    setMessage(null);
    try {
      await mutationFn(values);
      setMessage({ tone: 'success', text: 'Saved.' });
      onDone?.();
    } catch (error) {
      if (!applyFieldErrors(error, setError))
        setMessage({ tone: 'error', text: authErrorMessage(error) });
    }
  };
  return { message, submit };
}

function Dependents() {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const dependents = useQuery({
    queryKey: ['patients', 'dependents'],
    queryFn: patientsApi.dependents,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['patients', 'dependents'] });
  const create = useSave(patientsApi.createDependent, () => {
    setAdding(false);
    refresh();
  });
  const end = useSafeMutation({ mutationFn: patientsApi.endGuardianship, onSuccess: refresh });
  const { confirm, dialog } = useConfirm();
  const confirmEnd = async (d) => {
    const ok = await confirm({
      title: `Stop managing ${d.fullName}’s care?`,
      description:
        'You will no longer see their appointments, records or follow-ups, or book for them. Their health record is kept.',
      confirmLabel: 'Stop managing',
      destructive: true,
      tone: 'warning',
    });
    if (ok) end.mutate(d.guardianship.id);
  };

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-text">Family members</h2>
          <p className="mt-1 text-sm text-text-muted">
            People whose care you manage, such as a child or an elderly parent without their own
            account.
          </p>
        </div>
        {!adding && (
          <Button variant="secondary" onClick={() => setAdding(true)}>
            Add family member
          </Button>
        )}
      </div>
      {create.message && (
        <Alert tone={create.message.tone} className="mt-4">
          {create.message.text}
        </Alert>
      )}
      {adding && (
        <div className="mt-6 border-t border-border pt-6">
          <PatientProfileForm
            schema={createDependentSchema}
            submitLabel="Add family member"
            onSubmit={create.submit}
            extraFields={(register, errors) => (
              <SelectField
                label="Your relationship to them"
                placeholder="Select…"
                options={RELATIONSHIP_OPTIONS}
                error={errors.relationshipType?.message}
                {...register('relationshipType')}
              />
            )}
          />
        </div>
      )}
      {dialog}
      {end.isError && (
        <Alert tone="error" className="mt-4">
          {authErrorMessage(end.error)}
        </Alert>
      )}
      {dependents.isError && (
        <Alert tone="error" className="mt-4">
          {authErrorMessage(dependents.error)}
        </Alert>
      )}
      {dependents.isPending && <Skeleton className="mt-6 h-12 w-full" />}
      {dependents.data?.length > 0 && (
        <ul className="mt-6 divide-y divide-border">
          {dependents.data.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 py-4">
              <div>
                <p className="text-sm font-medium text-text">{d.fullName}</p>
                <p className="text-xs text-text-subtle">
                  You are their {d.guardianship.relationshipType.replace('_', ' ')} · born{' '}
                  {d.dateOfBirth}
                </p>
              </div>
              <div className="flex gap-2">
                <Link
                  to={`/app/doctors?patientId=${d.id}`}
                  className="min-h-11 rounded-lg px-3 py-2.5 text-sm font-medium text-primary hover:bg-surface-muted"
                >
                  Their doctors
                </Link>
                <Button
                  variant="ghost"
                  onClick={() => confirmEnd(d)}
                  disabled={end.isPending}
                  aria-label={`Stop managing ${d.fullName}`}
                >
                  Stop managing
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function ProfilePage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const profile = useQuery({
    queryKey: ['patients', 'me'],
    queryFn: patientsApi.me,
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 1,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['patients', 'me'] });
  const [justCreated, setJustCreated] = useState(false);
  const create = useSave(patientsApi.createMe, () => {
    setJustCreated(true);
    refresh();
  });
  const update = useSave(patientsApi.updateMe, refresh);
  const missing = profile.error instanceof ApiError && profile.error.status === 404;

  return (
    <div className="space-y-6">
      <div>
        <PageHeader
          icon={UserRound}
          eyebrow="Account"
          title="Profile"
          description="Your health profile and the family members whose care you manage. Doctors see it only when you add them to your care team."
        >
          <p className="mt-1.5 text-sm text-text-muted">
            Password and signed-in devices are under{' '}
            <Link to="/app/account" className="font-medium text-primary hover:text-primary-hover">
              Sign-in &amp; security
            </Link>
            .
          </p>
        </PageHeader>
      </div>
      <Card>
        {profile.isPending && <Skeleton className="h-40 w-full" />}
        {missing && (
          <>
            <h2 className="mb-6 text-base font-semibold text-text">Create your health profile</h2>
            {create.message && (
              <Alert tone={create.message.tone} className="mb-6">
                {create.message.text}
              </Alert>
            )}
            <PatientProfileForm
              submitLabel="Create profile"
              initial={{ fullName: user.fullName }}
              onSubmit={create.submit}
            />
          </>
        )}
        {profile.data && (
          <>
            {justCreated && !update.message && (
              <Alert tone="success" title="Your health profile is ready" className="mb-6">
                Next, add your doctor: find them among verified doctors and send a request.
                <span className="mt-3 block">
                  <ButtonLink as={Link} to="/app/doctors" size="sm" icon={Stethoscope}>
                    Find a doctor
                  </ButtonLink>
                </span>
              </Alert>
            )}
            {update.message && (
              <Alert tone={update.message.tone} className="mb-6">
                {update.message.text}
              </Alert>
            )}
            <PatientProfileForm
              initial={profile.data}
              submitLabel="Save changes"
              onSubmit={update.submit}
            />
          </>
        )}
        {profile.isError && !missing && (
          <Alert tone="error">{authErrorMessage(profile.error)}</Alert>
        )}
      </Card>
      {profile.data && <Dependents />}
      <Card>
        <h2 className="text-base font-semibold text-text">Are you a doctor?</h2>
        <p className="mt-1 text-sm text-text-muted">
          Create a professional profile and submit your registration for verification.
        </p>
        <Link
          to="/app/doctor-profile"
          className="mt-4 inline-block text-sm font-medium text-primary hover:text-primary-hover"
        >
          Set up a doctor profile
        </Link>
      </Card>
    </div>
  );
}
