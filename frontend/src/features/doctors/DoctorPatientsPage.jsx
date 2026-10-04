import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { careApi, doctorsApi, followUpApi, schedulingApi } from '../../lib/domainApi.js';
import { ACTIVE, ageFrom, coversDocuments, useSharedRecords } from './doctorWork.js';
import { formatDateTime } from '../appointments/format.js';
import { authErrorMessage } from '../auth/errorMessages.js';
import { Card } from '../../components/ui/Card.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { Button, ButtonLink } from '../../components/ui/Button.jsx';
import { Badge, StatusBadge } from '../../components/ui/Badge.jsx';
import { Skeleton } from '../../components/ui/Skeleton.jsx';
import { UsersRound } from 'lucide-react';
import { PageHeader } from '../../components/ui/Typography.jsx';
import { controlClass } from '../../components/ui/fieldStyles.js';
import { PersonIdentity } from '../../components/ui/Identity.jsx';
import { useConfirm } from '../../components/ui/useConfirm.jsx';
import { EmptyState, LoadingState } from '../../components/ui/EmptyState.jsx';
import { SectionHeader } from '../../components/ui/Typography.jsx';
import { CalendarDays, FolderOpen, Lock, ShieldCheck, UserPlus } from 'lucide-react';

function InvitePatient({ onDone }) {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState(null);
  const invite = useMutation({
    mutationFn: () => careApi.invite({ email }),
    onSuccess: (result) => {
      setMessage({ tone: 'success', text: result.message });
      setEmail('');
      onDone();
    },
    onError: (error) => setMessage({ tone: 'error', text: authErrorMessage(error) }),
  });
  return (
    <Card>
      <h2 className="text-base font-semibold text-text">Invite an existing patient</h2>
      <p className="mt-1 text-sm text-text-muted">
        The patient decides whether to accept. You get access only after they accept.
      </p>
      <form
        className="mt-4 flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          invite.mutate();
        }}
      >
        <label htmlFor="invite-email" className="sr-only">
          Patient email
        </label>
        <input
          id="invite-email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="patient@example.com"
          className={`${controlClass(false, { inline: true })} flex-1`}
        />
        <Button type="submit" variant="secondary" disabled={invite.isPending}>
          Send invitation
        </Button>
      </form>
      {message && (
        <Alert tone={message.tone} className="mt-4">
          {message.text}
        </Alert>
      )}
    </Card>
  );
}

const ATTENTION = ['urgent', 'needs_attention', 'responded'];

function PatientRow({ r, consent, next, followUp, onEnd }) {
  const age = ageFrom(r.patient.dateOfBirth);
  const shared = coversDocuments(consent);
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 py-4">
      <div className="min-w-0 space-y-2">
        <PersonIdentity
          name={r.patient.fullName ?? r.patient.displayName ?? 'Patient'}
          detail={age !== null ? `${age} years` : undefined}
          tone="neutral"
        />
        <div className="flex flex-wrap gap-1.5">
          {r.status !== 'active' && <StatusBadge status={r.status} />}
          {followUp && (
            <StatusBadge
              status={followUp.status}
              label={`Follow-up: ${
                followUp.status === 'urgent'
                  ? 'urgent'
                  : followUp.status === 'needs_attention'
                    ? 'needs attention'
                    : 'answered'
              }`}
            />
          )}
          {next && (
            <Badge tone="primary" icon={CalendarDays}>
              Next: {formatDateTime(next.startsAt)}
            </Badge>
          )}
          {shared ? (
            <Badge tone="primary" icon={ShieldCheck}>
              Records shared
            </Badge>
          ) : (
            <Badge icon={Lock}>Records not shared</Badge>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {followUp && (
          <ButtonLink as={Link} to={`/app/follow-ups?open=${followUp.id}`} size="sm">
            Review follow-up
          </ButtonLink>
        )}
        {shared && (
          <ButtonLink
            as={Link}
            to={`/app/medical-records/${r.patient.id}`}
            size="sm"
            variant="secondary"
            icon={FolderOpen}
          >
            Patient record
          </ButtonLink>
        )}
        {['active', 'paused'].includes(r.status) && (
          <Button variant="ghost" size="sm" onClick={() => onEnd(r)}>
            End relationship
          </Button>
        )}
      </div>
    </li>
  );
}

export function DoctorPatientsPage() {
  const queryClient = useQueryClient();
  const patients = useQuery({
    queryKey: ['doctors', 'patients'],
    queryFn: () => doctorsApi.myPatients(),
  });
  const shared = useSharedRecords();
  const [range] = useState(() => {
    const from = new Date();
    return {
      from: from.toISOString(),
      to: new Date(from.getTime() + 62 * 86_400_000).toISOString(),
    };
  });
  const upcoming = useQuery({
    queryKey: ['doctor-schedule', 'upcoming62'],
    queryFn: () => schedulingApi.doctorSchedule(range.from, range.to),
  });
  const followUps = useQuery({
    queryKey: ['doctor-follow-ups', 'open'],
    queryFn: () => followUpApi.forDoctor('open'),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['doctors', 'patients'] });
  const act = useMutation({
    mutationFn: ({ id, action }) => careApi.act(id, action),
    onSuccess: refresh,
  });
  const { confirm, dialog } = useConfirm();
  const confirmEnd = async (r) => {
    const ok = await confirm({
      title: 'End this care relationship?',
      description:
        'You will no longer see this patient’s profile, and they can no longer book with you. The patient can add you again later.',
      confirmLabel: 'End relationship',
      destructive: true,
      tone: 'warning',
    });
    if (ok) act.mutate({ id: r.id, action: 'end' });
  };
  const confirmDecline = async (r) => {
    const ok = await confirm({
      title: `Decline ${r.patient.displayName}’s request?`,
      description: 'They will not be able to book with you. They can send a new request later.',
      confirmLabel: 'Decline request',
      destructive: true,
    });
    if (ok) act.mutate({ id: r.id, action: 'decline' });
  };

  const nextFor = (patientId) =>
    [...(upcoming.data ?? [])]
      .filter((a) => a.patientId === patientId && ACTIVE.includes(a.status))
      .sort((x, y) => x.startsAt.localeCompare(y.startsAt))[0];
  const followUpFor = (patientId) =>
    (followUps.data ?? [])
      .filter((f) => f.patientId === patientId && ATTENTION.includes(f.status))
      .sort((x, y) => ATTENTION.indexOf(x.status) - ATTENTION.indexOf(y.status))[0];
  const rank = (r) => {
    const f = followUpFor(r.patient.id);
    const n = nextFor(r.patient.id);
    return [f ? ATTENTION.indexOf(f.status) : 9, n ? n.startsAt : '9999'];
  };
  const all = patients.data ?? [];
  const pending = all.filter((r) => r.status === 'pending');
  const current = all
    .filter((r) => ['active', 'paused'].includes(r.status))
    .sort((x, y) => {
      const [fx, nx] = rank(x);
      const [fy, ny] = rank(y);
      return fx - fy || nx.localeCompare(ny);
    });
  const invited = all.filter((r) => r.status === 'invited');
  const ended = all.filter((r) => r.status === 'ended');

  return (
    <div className="space-y-6">
      <PageHeader
        icon={UsersRound}
        eyebrow="Patients"
        title="My Patients"
        description="Patients who chose you as their doctor. You see a patient’s records only while they share them with you."
      />
      {act.isError && <Alert tone="error">{authErrorMessage(act.error)}</Alert>}
      {patients.isError && <Alert tone="error">{authErrorMessage(patients.error)}</Alert>}
      {dialog}
      {patients.isPending && <LoadingState label="Loading patients" rows={2} />}
      {pending.length > 0 && (
        <Card className="border-primary/40">
          <SectionHeader
            icon={UserPlus}
            title={`Requests (${pending.length})`}
            description="These patients asked you to join their care team. Accepting lets them book with you and shows you their basic profile; their records stay private unless they share them."
          />
          <ul className="mt-4 divide-y divide-border">
            {pending.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <PersonIdentity name={r.patient.displayName} tone="neutral" />
                <div className="flex gap-2">
                  <Button onClick={() => act.mutate({ id: r.id, action: 'accept' })}>Accept</Button>
                  <Button variant="secondary" onClick={() => confirmDecline(r)}>
                    Decline
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {patients.data && (
        <Card>
          <SectionHeader
            icon={UsersRound}
            title={`Care team patients (${current.length})`}
            description="Follow-ups needing you come first, then the next consultations."
          />
          {current.length === 0 && (
            <div className="mt-3">
              <EmptyState compact icon={UsersRound} title="No patients yet">
                Patients add you from their My Doctors page, or you can invite a patient who already
                uses HealthBridge by email (below).
              </EmptyState>
            </div>
          )}
          <ul className="mt-2 divide-y divide-border">
            {current.map((r) => (
              <PatientRow
                key={r.id}
                r={r}
                consent={shared.byPatient.get(r.patient.id)}
                next={nextFor(r.patient.id)}
                followUp={followUpFor(r.patient.id)}
                onEnd={confirmEnd}
              />
            ))}
          </ul>
          {invited.length > 0 && (
            <div className="mt-4 border-t border-border pt-3">
              <p className="text-sm font-medium text-text">Invitations you sent</p>
              <ul className="mt-1 divide-y divide-border">
                {invited.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span className="text-sm text-text">
                      {r.patient.fullName ?? r.patient.displayName ?? 'Invited patient'}{' '}
                      <span className="text-text-muted">· waiting for them to accept</span>
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => act.mutate({ id: r.id, action: 'withdraw' })}
                    >
                      Withdraw
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {ended.length > 0 && (
            <details className="mt-4 border-t border-border pt-3">
              <summary className="cursor-pointer text-sm text-text-muted">
                Past patients ({ended.length})
              </summary>
              <ul className="mt-1 divide-y divide-border text-sm text-text-muted">
                {ended.map((r) => (
                  <li key={r.id} className="py-2">
                    {r.patient.fullName ?? r.patient.displayName ?? 'Patient'}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </Card>
      )}
      <InvitePatient onDone={refresh} />
    </div>
  );
}
