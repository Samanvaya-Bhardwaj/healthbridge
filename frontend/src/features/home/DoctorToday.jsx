import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Building2,
  CalendarDays,
  CheckCircle2,
  ClipboardList,
  FolderOpen,
  HeartPulse,
  Lock,
  Play,
  ShieldCheck,
  Sparkles,
  UserCheck,
  UserPlus,
  Video,
} from 'lucide-react';
import { consultationApi, doctorsApi, followUpApi, schedulingApi } from '../../lib/domainApi.js';
import { authErrorMessage } from '../auth/errorMessages.js';
import { Alert } from '../../components/ui/Alert.jsx';
import { Badge, StatusBadge } from '../../components/ui/Badge.jsx';
import { Button, ButtonLink } from '../../components/ui/Button.jsx';
import { Card } from '../../components/ui/Card.jsx';
import { EmptyState, LoadingState } from '../../components/ui/EmptyState.jsx';
import { PageHeader, SectionHeader } from '../../components/ui/Typography.jsx';
import { MODE_LABELS, formatDateTime, formatTime } from '../appointments/format.js';
import {
  ACTIVE,
  OPEN_ROOM,
  ageFrom,
  coversDocuments,
  paymentLabel,
  useSharedRecords,
  waitingWindowOpen,
} from '../doctors/doctorWork.js';

const dayRange = (now) => {
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setDate(to.getDate() + 1);
  return { from: from.toISOString(), to: to.toISOString() };
};
const longDate = (now) =>
  new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: 'numeric', month: 'long' }).format(
    new Date(now),
  );
const FOLLOW_UP_ORDER = ['urgent', 'needs_attention', 'responded'];

/** Live room state for one online appointment, polled only while its window is open. */
function useRoomState(a, now) {
  return useQuery({
    queryKey: ['consultation-status', a.id],
    queryFn: () => consultationApi.status(a.id),
    enabled: waitingWindowOpen(a, now),
    refetchInterval: 15_000,
    retry: false,
  });
}

function Chip({ tone = 'neutral', icon: Icon, children }) {
  return (
    <Badge tone={tone} icon={Icon}>
      {children}
    </Badge>
  );
}

/** One of today's consultations, with its state and the next action. */
function Visit({ a, consent, now, featured = false }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const room = useRoomState(a, now);
  const live = room.data?.consultation?.status === 'live' || a.status === 'in_consultation';
  const present = Boolean(room.data?.waitingRoom?.patientPresent);
  const roomPath = `/app/appointments/${a.id}/consultation`;
  const start = useMutation({
    mutationFn: () => consultationApi.start(a.id),
    onSuccess: () => navigate(roomPath),
  });
  const checkIn = useMutation({
    mutationFn: () => schedulingApi.action(a.id, 'check-in'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['doctor-today'] }),
  });
  const shared = coversDocuments(consent);
  const name = a.patient?.fullName ?? `Patient (ref ${a.reference})`;
  const age = ageFrom(a.patient?.dateOfBirth, now);
  const startable =
    !live &&
    ((a.mode === 'online' && a.status === 'confirmed' && waitingWindowOpen(a, now)) ||
      a.status === 'checked_in');

  let primary = null;
  if (live) {
    primary = (
      <ButtonLink as={Link} to={roomPath} icon={a.mode === 'online' ? Video : Play}>
        {a.mode === 'online' ? 'Join video' : 'Continue consultation'}
      </ButtonLink>
    );
  } else if (startable) {
    primary = (
      <Button icon={Play} onClick={() => start.mutate()} loading={start.isPending}>
        Start consultation
      </Button>
    );
  } else if (
    a.status === 'confirmed' &&
    a.mode === 'in_clinic' &&
    now >= new Date(a.startsAt).getTime() - 60 * 60_000 &&
    now < new Date(a.endsAt).getTime()
  ) {
    primary = (
      <Button
        variant="secondary"
        icon={UserCheck}
        onClick={() => checkIn.mutate()}
        loading={checkIn.isPending}
      >
        Check in
      </Button>
    );
  } else if (OPEN_ROOM.includes(a.status)) {
    primary = (
      <ButtonLink
        as={Link}
        to={roomPath}
        variant="secondary"
        icon={a.status === 'completed' ? ClipboardList : undefined}
      >
        {a.status === 'completed' ? 'Summary' : 'Open appointment'}
      </ButtonLink>
    );
  }

  return (
    <li className={featured ? '' : 'px-4 py-4 sm:px-5'}>
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <div className="w-16 shrink-0">
          <p className="text-base font-semibold tabular-nums text-text">{formatTime(a.startsAt)}</p>
          <p className="text-xs text-text-subtle">{formatTime(a.endsAt)}</p>
        </div>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 font-medium text-text">
            {name}
            {age !== null && (
              <span className="text-sm font-normal text-text-muted">· {age} yrs</span>
            )}
          </p>
          <p className="mt-0.5 flex items-center gap-1.5 text-sm text-text-muted">
            {a.mode === 'online' ? (
              <Video aria-hidden="true" className="h-4 w-4" />
            ) : (
              <Building2 aria-hidden="true" className="h-4 w-4" />
            )}
            {MODE_LABELS[a.mode]}
            {a.clinic && ` · ${a.clinic.name}`}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <StatusBadge status={live ? 'in_consultation' : a.status} />
            {paymentLabel(a) && (
              <Chip tone={a.status === 'pending_payment' ? 'warning' : 'neutral'}>
                {paymentLabel(a)}
              </Chip>
            )}
            {a.mode === 'online' && waitingWindowOpen(a, now) && !live && (
              <Chip tone={present ? 'success' : 'neutral'} icon={present ? UserCheck : undefined}>
                {present ? 'In the waiting room' : 'Not in the waiting room yet'}
              </Chip>
            )}
            {shared ? (
              <Chip tone="primary" icon={ShieldCheck}>
                Records shared
              </Chip>
            ) : (
              <Chip icon={Lock}>Records not shared</Chip>
            )}
          </div>
        </div>
        <div className="flex w-full flex-wrap gap-2 sm:pl-20">
          {primary}
          {shared && (
            <ButtonLink
              as={Link}
              to={`/app/medical-records/${a.patientId}`}
              variant="ghost"
              icon={FolderOpen}
            >
              Review patient
            </ButtonLink>
          )}
          {shared && ACTIVE.includes(a.status) && (
            <ButtonLink
              as={Link}
              to={`/app/appointments/${a.id}/brief`}
              variant="ghost"
              icon={Sparkles}
            >
              AI brief
            </ButtonLink>
          )}
        </div>
      </div>
      {(start.isError || checkIn.isError) && (
        <Alert tone="error" className="mt-3">
          {authErrorMessage(start.error ?? checkIn.error)}
        </Alert>
      )}
    </li>
  );
}

/**
 * Doctor home: today's work first. The next consultation is featured; the rest of the
 * day follows in time order; patients needing attention sit alongside.
 */
export function DoctorToday({ firstName }) {
  const [now] = useState(() => Date.now());
  const range = dayRange(now);
  const today = useQuery({
    queryKey: ['doctor-today', range.from],
    queryFn: () => schedulingApi.doctorSchedule(range.from, range.to),
    refetchInterval: 60_000,
  });
  const shared = useSharedRecords();
  const followUps = useQuery({
    queryKey: ['doctor-follow-ups', 'open'],
    queryFn: () => followUpApi.forDoctor('open'),
  });
  const patients = useQuery({
    queryKey: ['doctors', 'patients'],
    queryFn: () => doctorsApi.myPatients(),
  });

  const visits = [...(today.data ?? [])]
    .filter((a) => !['cancelled', 'expired'].includes(a.status))
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const cancelled = (today.data ?? []).filter((a) => ['cancelled', 'expired'].includes(a.status));
  const next =
    visits.find((a) => a.status === 'in_consultation') ??
    visits.find((a) => ACTIVE.includes(a.status) && new Date(a.endsAt).getTime() > now);
  const rest = visits.filter((a) => a !== next);
  const remaining = visits.filter((a) => ACTIVE.includes(a.status)).length;
  const attention = (followUps.data ?? [])
    .filter((f) => FOLLOW_UP_ORDER.includes(f.status))
    .sort((a, b) => FOLLOW_UP_ORDER.indexOf(a.status) - FOLLOW_UP_ORDER.indexOf(b.status));
  const urgent = attention.filter((f) => f.status === 'urgent').length;
  const requests = (patients.data ?? []).filter((r) => r.status === 'pending');

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={longDate(now)}
        title="Today"
        description={
          today.isSuccess
            ? `Good to see you, ${firstName}. ${
                remaining
                  ? `${remaining} consultation${remaining === 1 ? '' : 's'} still to go today.`
                  : 'No more consultations today.'
              }`
            : `Good to see you, ${firstName}.`
        }
        actions={
          <ButtonLink as={Link} to="/app/appointments" variant="secondary" icon={CalendarDays}>
            Week schedule
          </ButtonLink>
        }
      />

      {urgent > 0 && (
        <Alert
          tone="error"
          title={`${urgent} urgent check-in${urgent === 1 ? '' : 's'}`}
          action={
            <ButtonLink as={Link} to="/app/follow-ups" size="sm" variant="danger">
              Review now
            </ButtonLink>
          }
        >
          A patient reported a warning sign and was shown emergency guidance. Please review.
        </Alert>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-6">
          {today.isPending && <LoadingState label="Loading today’s consultations" rows={3} />}
          {today.isError && <Alert tone="error">{authErrorMessage(today.error)}</Alert>}
          {today.isSuccess && visits.length === 0 && (
            <EmptyState
              icon={CalendarDays}
              title="No consultations today"
              action={
                <ButtonLink as={Link} to="/app/appointments?tab=availability" variant="secondary">
                  Check your hours
                </ButtonLink>
              }
            >
              Patients in your care team book from your published hours. Make sure they are up to
              date.
            </EmptyState>
          )}
          {next && (
            <section
              aria-labelledby="next-heading"
              className="rounded-2xl border-2 border-primary/40 bg-surface-raised p-5"
            >
              <h2
                id="next-heading"
                className="mb-3 text-xs font-semibold uppercase tracking-wide text-primary"
              >
                {next.status === 'in_consultation' ? 'In progress' : 'Next up'}
              </h2>
              <ul>
                <Visit a={next} consent={shared.byPatient.get(next.patientId)} now={now} featured />
              </ul>
            </section>
          )}
          {rest.length > 0 && (
            <section aria-labelledby="day-heading" className="space-y-3">
              <SectionHeader id="day-heading" icon={CalendarDays} title="Today’s consultations" />
              <ul className="divide-y divide-border rounded-2xl border border-border bg-surface-raised">
                {rest.map((a) => (
                  <Visit key={a.id} a={a} consent={shared.byPatient.get(a.patientId)} now={now} />
                ))}
              </ul>
            </section>
          )}
          {cancelled.length > 0 && (
            <p className="text-sm text-text-muted">
              {cancelled.length} cancelled or released booking{cancelled.length === 1 ? '' : 's'}{' '}
              today — see the{' '}
              <Link to="/app/appointments" className="font-medium text-primary">
                schedule
              </Link>
              .
            </p>
          )}
        </div>

        <aside className="space-y-6" aria-label="Patients needing attention">
          <Card>
            <SectionHeader
              icon={HeartPulse}
              title="Follow-ups to review"
              actions={
                <ButtonLink as={Link} to="/app/follow-ups" variant="subtle" size="sm">
                  All
                </ButtonLink>
              }
            />
            {followUps.isPending ? (
              <LoadingState label="Loading follow-ups" rows={1} className="mt-3" />
            ) : attention.length === 0 ? (
              <p className="mt-3 flex items-center gap-2 text-sm text-text-muted">
                <CheckCircle2 aria-hidden="true" className="h-4 w-4 text-success" />
                Nothing waiting for review.
              </p>
            ) : (
              <ul className="mt-2 divide-y divide-border">
                {attention.slice(0, 6).map((f) => (
                  <li key={f.id}>
                    <Link
                      to={`/app/follow-ups?open=${f.id}`}
                      className="flex items-center justify-between gap-2 py-2.5 text-sm hover:text-primary"
                    >
                      <span className="flex min-w-0 items-center gap-2 font-medium text-text">
                        {f.status === 'urgent' && (
                          <AlertTriangle aria-hidden="true" className="h-4 w-4 text-danger" />
                        )}
                        <span className="truncate">{f.patientName ?? 'Patient'}</span>
                      </span>
                      <StatusBadge status={f.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card>
            <SectionHeader
              icon={UserPlus}
              title="New patient requests"
              actions={
                <ButtonLink as={Link} to="/app/patients" variant="subtle" size="sm">
                  My patients
                </ButtonLink>
              }
            />
            {patients.isPending ? (
              <LoadingState label="Loading requests" rows={1} className="mt-3" />
            ) : requests.length === 0 ? (
              <p className="mt-3 text-sm text-text-muted">No requests waiting.</p>
            ) : (
              <div className="mt-3">
                <p className="text-sm text-text">
                  {requests.length} patient{requests.length === 1 ? '' : 's'} asked you to join
                  their care team.
                </p>
                <ButtonLink as={Link} to="/app/patients" size="sm" className="mt-3">
                  Review requests
                </ButtonLink>
              </div>
            )}
          </Card>
          <p className="text-xs text-text-subtle">
            Updated {formatDateTime(new Date(today.dataUpdatedAt || now).toISOString())}. Waiting
            room status refreshes every 15 seconds.
          </p>
        </aside>
      </div>
    </div>
  );
}
