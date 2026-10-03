import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { careApi, doctorsApi, patientsApi } from '../../lib/domainApi.js';
import { ApiError } from '../../lib/apiClient.js';
import { authErrorMessage } from '../auth/errorMessages.js';
import { Card } from '../../components/ui/Card.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { Button, ButtonLink } from '../../components/ui/Button.jsx';
import { PersonIdentity } from '../../components/ui/Identity.jsx';
import { useConfirm } from '../../components/ui/useConfirm.jsx';
import { controlClass } from '../../components/ui/fieldStyles.js';
import { MissingProfileNotice } from '../patients/MissingProfileNotice.jsx';
import { StatusBadge } from '../../components/ui/Badge.jsx';
import { EmptyState, LoadingState } from '../../components/ui/EmptyState.jsx';
import { CalendarDays, Search, Stethoscope, UserPlus } from 'lucide-react';
import { PageHeader, SectionHeader } from '../../components/ui/Typography.jsx';

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
      <SectionHeader
        icon={Search}
        title="Find a verified doctor"
        description="Search by name or specialty. Only doctors whose registration HealthBridge has verified are listed."
      />
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
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Name or specialty"
          className={`${controlClass(false, { inline: true })} flex-1`}
        />
        <Button type="submit" variant="secondary" icon={Search}>
          Search
        </Button>
      </form>
      {message && (
        <Alert tone={message.tone} className="mt-4">
          {message.text}
        </Alert>
      )}
      {results.isPending && <LoadingState label="Searching doctors" rows={2} className="mt-4" />}
      {results.data?.length === 0 && (
        <EmptyState compact title="No verified doctors match" icon={Search}>
          Try another name or specialty. If your doctor is not on HealthBridge yet, ask them to
          join; they can then invite you.
        </EmptyState>
      )}
      <ul className="mt-4 divide-y divide-border">
        {results.data?.map((doctor) => (
          <li key={doctor.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <PersonIdentity
              name={doctor.professionalName}
              verified
              detail={`${doctor.primarySpecialization} · ${doctor.yearsOfExperience} yrs${
                doctor.clinics.length > 0
                  ? ` · ${doctor.clinics.map((c) => c.name).join(', ')}`
                  : ''
              }`}
            />
            {existingDoctorIds.has(doctor.id) ? (
              <span className="text-xs text-text-subtle">In your care team</span>
            ) : (
              <Button
                variant="secondary"
                icon={UserPlus}
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
  const { confirm, dialog } = useConfirm();

  if (self.error instanceof ApiError && self.error.status === 404 && !dependentId) {
    return <MissingProfileNotice />;
  }

  const existingDoctorIds = new Set((team.data ?? []).map((r) => r.doctorId));
  const onAction = async (rel, action) => {
    if (action === 'end') {
      const ok = await confirm({
        title: `Remove ${rel.doctor.professionalName} from the care team?`,
        description:
          'The doctor loses access to the profile at once, and you can no longer book with them. Any consent you gave them stays listed in Privacy & Access until it ends or you revoke it.',
        confirmLabel: 'Remove doctor',
        destructive: true,
        tone: 'warning',
      });
      if (!ok) return;
    }
    act.mutate({ id: rel.id, action });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Stethoscope}
        eyebrow="My care"
        title={dependentId ? 'Their Doctors' : 'My Doctors'}
        description="The doctors you trust. Add your family doctor here, then book with them. A doctor sees your basic profile only while the relationship is active, and your records only with your consent."
      />
      {dialog}
      {act.isError && <Alert tone="error">{authErrorMessage(act.error)}</Alert>}
      <Card>
        <SectionHeader icon={Stethoscope} title="Care team" />
        {team.isPending && <LoadingState label="Loading care team" rows={1} className="mt-3" />}
        {team.data?.length === 0 && (
          <div className="mt-3">
            <EmptyState compact icon={Stethoscope} title="No doctors in this care team yet">
              Search for your family doctor below and send a request. Once they accept, you can book
              consultations with them.
            </EmptyState>
          </div>
        )}
        <ul className="divide-y divide-border">
          {team.data?.map((rel) => (
            <li key={rel.id} className="flex flex-wrap items-center justify-between gap-3 py-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <PersonIdentity
                    name={rel.doctor.professionalName}
                    verified
                    detail={`${rel.doctor.primarySpecialization}${rel.clinic ? ` · ${rel.clinic.name}` : ''}`}
                  />
                  <StatusBadge status={rel.status} />
                </div>
                <p className="mt-1 text-sm text-text-muted">{STATE_HELP[rel.status]}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                {rel.status === 'active' && (
                  <ButtonLink
                    as={Link}
                    to={`/app/appointments/book?doctorId=${rel.doctorId}&patientId=${rel.patientId}`}
                    icon={CalendarDays}
                  >
                    Book
                  </ButtonLink>
                )}
                {(PATIENT_ACTIONS[rel.status] ?? []).map(([action, label]) => (
                  <Button
                    key={action}
                    variant={action === 'accept' || action === 'resume' ? 'primary' : 'secondary'}
                    disabled={act.isPending}
                    onClick={() => onAction(rel, action)}
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
