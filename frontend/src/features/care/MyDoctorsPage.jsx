import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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
import { CalendarDays, ChevronDown, HelpCircle, Search, Stethoscope, UserPlus } from 'lucide-react';
import { PageHeader, SectionHeader } from '../../components/ui/Typography.jsx';
import { AvailabilitySummary, DoctorCredentials } from './DoctorInfo.jsx';
import { useDoctorProfile, useDoctorSlots } from './doctorInfo.js';
import { useSafeMutation } from '../../lib/useSafeMutation.js';
import { PatientSelect } from '../records/PatientSelect.jsx';

/** Which actions the patient side can take in each state (the server enforces the same rules). */
const PATIENT_ACTIONS = {
  invited: [
    ['accept', 'Accept'],
    ['decline', 'Decline'],
  ],
  pending: [['withdraw', 'Withdraw request']],
  active: [
    ['pause', 'Pause'],
    ['end', 'Remove'],
  ],
  paused: [
    ['resume', 'Resume'],
    ['end', 'Remove'],
  ],
};

/** Patient-facing name and meaning of each relationship state. */
const STATES = {
  invited: {
    label: 'Invitation',
    help: (name) => `${name} invited you to their care. Nothing is shared unless you accept.`,
  },
  pending: {
    label: 'Request pending',
    help: (name) =>
      `Waiting for ${name} to accept. You will get a notification; you can book once they accept.`,
  },
  active: {
    label: 'Accepted',
    help: (name) =>
      `You can book consultations. ${name} sees your basic profile; your records only if you share them in Privacy & Access.`,
  },
  paused: {
    label: 'Paused',
    help: (name) =>
      `${name} can’t see your profile and you can’t book until you resume. Nothing was deleted.`,
  },
  ended: { label: 'Ended', help: () => 'This relationship has ended. You can send a new request.' },
  declined: { label: 'Declined', help: () => 'The request was declined.' },
  withdrawn: { label: 'Withdrawn', help: () => 'The request was withdrawn.' },
};
const CURRENT = new Set(['invited', 'pending', 'active', 'paused']);

const LEGEND = [
  ['Request', 'You find a verified doctor below and ask them to join your care team.'],
  ['Pending', 'The doctor hasn’t answered yet. Nothing is shared while you wait.'],
  [
    'Accepted',
    'You can book with them. They see your basic profile (name, age, contact); never your records unless you share them.',
  ],
  ['Paused', 'Their access and your bookings stop until you resume. You can resume at any time.'],
  ['Ended', 'The relationship is over. You can send a new request later.'],
];

function StateLegend() {
  return (
    <details className="group rounded-xl border border-border bg-surface-raised px-4 py-3">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium text-primary">
        <HelpCircle aria-hidden="true" className="h-4 w-4" />
        How a care team works
        <ChevronDown
          aria-hidden="true"
          className="ml-auto h-4 w-4 transition-transform group-open:rotate-180"
        />
      </summary>
      <ol className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {LEGEND.map(([title, text], i) => (
          <li key={title} className="rounded-lg bg-surface-muted p-3 text-sm">
            <p className="font-medium text-text">
              {i + 1}. {title}
            </p>
            <p className="mt-1 text-text-muted">{text}</p>
          </li>
        ))}
      </ol>
    </details>
  );
}

/** Expandable full profile; loads only when opened. */
function AboutDoctor({ doctorId }) {
  const [open, setOpen] = useState(false);
  const profile = useDoctorProfile(doctorId, { enabled: open });
  return (
    <details className="mt-3" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cursor-pointer text-sm font-medium text-primary">
        About this doctor
      </summary>
      <div className="mt-3">
        {open && profile.isPending && <LoadingState label="Loading profile" rows={1} />}
        {profile.isError && (
          <p className="text-sm text-text-muted">
            This doctor’s profile isn’t listed at the moment.
          </p>
        )}
        {profile.data && <DoctorCredentials doctor={profile.data} />}
      </div>
    </details>
  );
}

function CareTeamCard({ rel, onAction, busy }) {
  const name = rel.doctor.professionalName;
  const state = STATES[rel.status];
  const slots = useDoctorSlots(rel.doctorId, { enabled: rel.status === 'active' });
  return (
    <li className="py-4 first:pt-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <PersonIdentity
            name={name}
            verified
            detail={`${rel.doctor.primarySpecialization}${rel.clinic ? ` · ${rel.clinic.name}` : ''}`}
          />
        </div>
        <StatusBadge status={rel.status} label={state?.label} />
      </div>
      <p className="mt-2 text-sm text-text-muted">{state?.help(name)}</p>
      {rel.status === 'active' && (
        <div className="mt-3">
          <AvailabilitySummary slots={slots} />
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {rel.status === 'active' && (
          <ButtonLink
            as={Link}
            to={`/app/appointments/book?doctorId=${rel.doctorId}&patientId=${rel.patientId}`}
            icon={CalendarDays}
          >
            Book a consultation
          </ButtonLink>
        )}
        {(PATIENT_ACTIONS[rel.status] ?? []).map(([action, label]) => (
          <Button
            key={action}
            variant={
              action === 'accept' || action === 'resume'
                ? 'primary'
                : action === 'end' || action === 'decline'
                  ? 'ghost'
                  : 'secondary'
            }
            disabled={busy}
            onClick={() => onAction(rel, action)}
          >
            {label}
          </Button>
        ))}
      </div>
      <AboutDoctor doctorId={rel.doctorId} />
    </li>
  );
}

const IN_TEAM_TEXT = {
  pending: 'Request sent: waiting for them to accept',
  invited: 'They invited you: see the care team above',
};

function SearchResult({ doctor, teamStatus, onRequest, busy }) {
  const inTeam = Boolean(teamStatus);
  const [open, setOpen] = useState(false);
  const slots = useDoctorSlots(doctor.id, { enabled: open });
  const clinic = doctor.clinics[0];
  return (
    <li className="py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PersonIdentity
          name={doctor.professionalName}
          verified
          detail={`${doctor.primarySpecialization} · ${doctor.yearsOfExperience} yrs experience${
            clinic ? ` · ${clinic.name}` : ''
          }`}
        />
        {inTeam ? (
          <span className="text-sm text-text-muted">
            {IN_TEAM_TEXT[teamStatus] ?? 'Already in the care team'}
          </span>
        ) : (
          <Button variant="secondary" icon={UserPlus} disabled={busy} onClick={onRequest}>
            Request
          </Button>
        )}
      </div>
      {doctor.languages?.length > 0 && (
        <p className="mt-1 text-sm text-text-muted sm:pl-12">
          Speaks {doctor.languages.join(', ')}
        </p>
      )}
      <details className="mt-2 sm:pl-12" onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary className="cursor-pointer text-sm font-medium text-primary">
          Profile and availability
        </summary>
        <div className="mt-3 space-y-4">
          <DoctorCredentials doctor={doctor} />
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-subtle">
              How and when you can consult
            </p>
            {open && <AvailabilitySummary slots={slots} />}
            {!inTeam && (
              <p className="mt-2 text-xs text-text-subtle">
                You can book once {doctor.professionalName} accepts your request.
              </p>
            )}
          </div>
        </div>
      </details>
    </li>
  );
}

function DoctorSearch({ patientId, teamStatusByDoctor, onRequested }) {
  const [q, setQ] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [message, setMessage] = useState(null);
  const results = useQuery({
    queryKey: ['doctors', 'directory', submitted],
    queryFn: async () => (await doctorsApi.directory({ q: submitted || undefined })).data,
  });
  const request = useSafeMutation({
    mutationFn: (doctor) => careApi.request({ patientId, doctorId: doctor.id }),
    onSuccess: (_rel, doctor) => {
      setMessage({
        tone: 'success',
        text: `Request sent to ${doctor.professionalName}. Once they accept, you can book; you’ll get a notification.`,
      });
      onRequested();
    },
    onError: (error) => setMessage({ tone: 'error', text: authErrorMessage(error) }),
  });

  return (
    <Card>
      <SectionHeader
        icon={Search}
        title="Find a verified doctor"
        description="Every doctor listed has had their medical registration checked by HealthBridge. Search by name or speciality."
      />
      <form
        role="search"
        className="mt-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(q.trim().length >= 2 ? q.trim() : '');
        }}
      >
        <label htmlFor="doctor-search" className="sr-only">
          Search by name or speciality
        </label>
        <input
          id="doctor-search"
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Name or speciality"
          className={`${controlClass(false, { inline: true })} min-w-0 flex-1`}
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
      {results.isError && (
        <Alert tone="error" className="mt-4">
          {authErrorMessage(results.error)}
        </Alert>
      )}
      {results.data?.length === 0 && (
        <div className="mt-4">
          <EmptyState compact title="No verified doctors match" icon={Search}>
            Try another name or speciality. If your doctor isn’t on HealthBridge yet, ask them to
            join; once verified, they can invite you.
          </EmptyState>
        </div>
      )}
      <ul className="mt-2 divide-y divide-border">
        {results.data?.map((doctor) => (
          <SearchResult
            key={doctor.id}
            doctor={doctor}
            teamStatus={teamStatusByDoctor.get(doctor.id)}
            busy={request.isPending}
            onRequest={() => request.mutate(doctor)}
          />
        ))}
      </ul>
    </Card>
  );
}

export function MyDoctorsPage() {
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const self = useQuery({ queryKey: ['patients', 'me'], queryFn: patientsApi.me, retry: false });
  const dependents = useQuery({
    queryKey: ['patients', 'dependents'],
    queryFn: patientsApi.dependents,
  });
  // Visiting your own id (from the switch) is the same as no dependent.
  const requested = params.get('patientId') ?? undefined;
  const dependentId = requested && requested !== self.data?.id ? requested : undefined;
  const dependent = (dependents.data ?? []).find((d) => d.id === dependentId);
  const dependentName = dependent?.preferredName || dependent?.fullName?.split(' ')[0];
  const whose = dependentName ? `${dependentName}’s` : 'their';
  const choices = [
    ...(self.data ? [{ id: self.data.id, label: 'Me' }] : []),
    ...(dependents.data ?? []).map((d) => ({ id: d.id, label: d.fullName })),
  ];
  const patientId = dependentId ?? self.data?.id;
  const team = useQuery({
    queryKey: ['care', patientId],
    queryFn: () => careApi.list(dependentId),
    enabled: Boolean(patientId),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['care', patientId] });
  const act = useSafeMutation({
    mutationFn: ({ id, action }) => careApi.act(id, action),
    onSuccess: refresh,
  });
  const { confirm, dialog } = useConfirm();

  if (self.error instanceof ApiError && self.error.status === 404 && !dependentId) {
    return <MissingProfileNotice />;
  }

  const current = (team.data ?? []).filter((r) => CURRENT.has(r.status));
  const past = (team.data ?? []).filter((r) => !CURRENT.has(r.status));
  // Only open relationships block a new request (ended ones can be requested again).
  const teamStatusByDoctor = new Map(current.map((r) => [r.doctorId, r.status]));
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
        title={
          dependentId
            ? dependentName
              ? `${dependentName}’s doctors`
              : 'Their doctors'
            : 'My Doctors'
        }
        description={
          dependentId
            ? `You manage ${whose} care. Add ${whose} doctor; once the doctor accepts, you can book consultations for ${dependentName ?? 'them'}.`
            : 'The doctors you trust. Add your family doctor; once they accept, you can book online or in-clinic consultations with them.'
        }
      />
      <PatientSelect
        choices={choices}
        value={dependentId ?? self.data?.id}
        onChange={(id) => setParams(id === self.data?.id ? {} : { patientId: id })}
      />
      {dialog}
      {act.isError && <Alert tone="error">{authErrorMessage(act.error)}</Alert>}
      <StateLegend />
      <Card>
        <SectionHeader icon={Stethoscope} title="Care team" />
        {team.isPending && <LoadingState label="Loading care team" rows={1} className="mt-3" />}
        {team.isError && (
          <Alert tone="error" className="mt-3">
            {authErrorMessage(team.error)}
          </Alert>
        )}
        {team.isSuccess && current.length === 0 && (
          <div className="mt-3">
            <EmptyState compact icon={Stethoscope} title="No doctors in this care team yet">
              Search for your family doctor below and send a request. Once they accept, you can book
              consultations with them.
            </EmptyState>
          </div>
        )}
        <ul className="divide-y divide-border">
          {current.map((rel) => (
            <CareTeamCard key={rel.id} rel={rel} onAction={onAction} busy={act.isPending} />
          ))}
        </ul>
        {past.length > 0 && (
          <details className="mt-4 border-t border-border pt-3">
            <summary className="cursor-pointer text-sm text-text-muted">
              Past doctors and requests ({past.length})
            </summary>
            <ul className="mt-2 divide-y divide-border">
              {past.map((rel) => (
                <li key={rel.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="text-sm text-text">
                    {rel.doctor.professionalName}
                    <span className="block text-xs text-text-muted">
                      {STATES[rel.status]?.help(rel.doctor.professionalName)}
                    </span>
                  </span>
                  <StatusBadge status={rel.status} label={STATES[rel.status]?.label} />
                </li>
              ))}
            </ul>
          </details>
        )}
      </Card>
      {patientId && (
        <DoctorSearch
          patientId={patientId}
          teamStatusByDoctor={teamStatusByDoctor}
          onRequested={refresh}
        />
      )}
    </div>
  );
}
