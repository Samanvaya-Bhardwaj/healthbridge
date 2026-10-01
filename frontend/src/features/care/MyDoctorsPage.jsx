import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { careApi, doctorsApi, patientsApi } from '../../lib/domainApi.js';
import { ApiError } from '../../lib/apiClient.js';
import { authErrorMessage } from '../auth/errorMessages.js';
import { Card } from '../../components/ui/Card.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { StatusBadge } from '../../components/ui/Badge.jsx';
import { Skeleton } from '../../components/ui/Skeleton.jsx';
import { EmptyState } from '../../components/ui/EmptyState.jsx';

/** Which actions the patient side can take in each state (the server enforces the same rules). */
const PATIENT_ACTIONS = {
  invited: [
    ['accept', 'Accept'],
    ['decline', 'Decline'],
  ],
  pending: [['withdraw', 'Withdraw request']],
  active: [
    ['pause', 'Pause access'],
    ['end', 'Remove'],
  ],
  paused: [
    ['resume', 'Resume access'],
    ['end', 'Remove'],
  ],
};

const STATE_HELP = {
  invited: 'This doctor invited you. They get access only if you accept.',
  pending: 'Waiting for the doctor to accept.',
  active: 'This doctor can see your profile.',
  paused: 'Access paused: the doctor cannot see your profile until you resume.',
};

function DoctorSearch({ patientId, existingDoctorIds, onRequested }) {
  const [q, setQ] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [message, setMessage] = useState(null);
  const results = useQuery({
    queryKey: ['doctors', 'directory', submitted],
    queryFn: async () => (await doctorsApi.directory({ q: submitted || undefined })).data,
  });
  const request = useMutation({
    mutationFn: (doctor) => careApi.request({ patientId, doctorId: doctor.id }),
    onSuccess: () => {
      setMessage({ tone: 'success', text: 'Request sent. The doctor will see it in their list.' });
      onRequested();
    },
    onError: (error) => setMessage({ tone: 'error', text: authErrorMessage(error) }),
  });

  return (
    <Card>
      <h2 className="text-base font-semibold text-text">Find a verified doctor</h2>
      <form
        className="mt-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(q.trim().length >= 2 ? q.trim() : '');
        }}
      >
        <label htmlFor="doctor-search" className="sr-only">
          Search by name or specialty
        </label>
        <input
          id="doctor-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Name or specialty"
          className="min-h-11 flex-1 rounded-lg border border-border bg-surface-raised px-3.5"
        />
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </form>
      {message && (
        <Alert tone={message.tone} className="mt-4">
          {message.text}
        </Alert>
      )}
      {results.isPending && <Skeleton className="mt-4 h-12 w-full" />}
      <ul className="mt-4 divide-y divide-border">
        {results.data?.map((doctor) => (
          <li key={doctor.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div>
              <p className="text-sm font-medium text-text">{doctor.professionalName}</p>
              <p className="text-xs text-text-subtle">
                {doctor.primarySpecialization} · {doctor.yearsOfExperience} yrs
                {doctor.clinics.length > 0 && ` · ${doctor.clinics.map((c) => c.name).join(', ')}`}
              </p>
            </div>
            {existingDoctorIds.has(doctor.id) ? (
              <span className="text-xs text-text-subtle">In your care team</span>
            ) : (
              <Button
                variant="secondary"
                disabled={request.isPending}
                onClick={() => request.mutate(doctor)}
              >
                Request
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function MyDoctorsPage() {
  const [params] = useSearchParams();
  const dependentId = params.get('patientId') ?? undefined;
  const queryClient = useQueryClient();
  const self = useQuery({ queryKey: ['patients', 'me'], queryFn: patientsApi.me, retry: false });
  const patientId = dependentId ?? self.data?.id;
  const team = useQuery({
    queryKey: ['care', patientId],
    queryFn: () => careApi.list(dependentId),
    enabled: Boolean(patientId),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['care', patientId] });
  const act = useMutation({
    mutationFn: ({ id, action }) => careApi.act(id, action),
    onSuccess: refresh,
  });

  if (self.error instanceof ApiError && self.error.status === 404 && !dependentId) {
    return (
      <EmptyState
        title="Create your health profile first"
        action={
          <Link to="/app/profile" className="font-medium text-primary">
            Go to your profile
          </Link>
        }
      >
        Your care team is linked to your health profile.
      </EmptyState>
    );
  }

  const existingDoctorIds = new Set((team.data ?? []).map((r) => r.doctorId));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-text">
          {dependentId ? 'Their doctors' : 'My doctors'}
        </h1>
        <p className="mt-2 text-text-muted">
          The doctors you trust. A doctor can see the profile only while the relationship is active.
        </p>
      </div>
      {act.isError && <Alert tone="error">{authErrorMessage(act.error)}</Alert>}
      <Card>
        {team.isPending && <Skeleton className="h-16 w-full" />}
        {team.data?.length === 0 && (
          <p className="text-sm text-text-muted">No doctors in this care team yet.</p>
        )}
        <ul className="divide-y divide-border">
          {team.data?.map((rel) => (
            <li key={rel.id} className="flex flex-wrap items-center justify-between gap-3 py-4">
              <div>
                <p className="flex items-center gap-2 text-sm font-medium text-text">
                  {rel.doctor.professionalName} <StatusBadge status={rel.status} />
                </p>
                <p className="mt-0.5 text-xs text-text-subtle">
                  {rel.doctor.primarySpecialization}
                  {rel.clinic && ` · ${rel.clinic.name}`} — {STATE_HELP[rel.status]}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {rel.status === 'active' && (
                  <Link
                    to={`/app/appointments/book?doctorId=${rel.doctorId}&patientId=${rel.patientId}`}
                    className="min-h-11 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-contrast hover:bg-primary-hover"
                  >
                    Book
                  </Link>
                )}
                {(PATIENT_ACTIONS[rel.status] ?? []).map(([action, label]) => (
                  <Button
                    key={action}
                    variant={action === 'accept' || action === 'resume' ? 'primary' : 'secondary'}
                    disabled={act.isPending}
                    onClick={() => act.mutate({ id: rel.id, action })}
                  >
                    {label}
                  </Button>
                ))}
              </div>
            </li>
          ))}
        </ul>
      </Card>
      {patientId && (
        <DoctorSearch
          patientId={patientId}
          existingDoctorIds={existingDoctorIds}
          onRequested={refresh}
        />
      )}
    </div>
  );
}
