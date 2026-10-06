import { useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/authContext.js';
import { primaryRole } from '../../app/navigation.js';
import { schedulingApi } from '../../lib/domainApi.js';
import { authErrorMessage } from '../auth/errorMessages.js';
import { Card } from '../../components/ui/Card.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { Button, ButtonLink } from '../../components/ui/Button.jsx';
import { StatusBadge } from '../../components/ui/Badge.jsx';
import { EmptyState, LoadingState, PermissionNotice } from '../../components/ui/EmptyState.jsx';
import { PageHeader } from '../../components/ui/Typography.jsx';
import { Tabs } from '../../components/ui/Tabs.jsx';
import { useConfirm } from '../../components/ui/useConfirm.jsx';
import { PersonIdentity } from '../../components/ui/Identity.jsx';
import {
  Building2,
  CalendarClock,
  CreditCard,
  CalendarDays,
  ClipboardList,
  Sparkles,
  Stethoscope,
  Video,
} from 'lucide-react';
import { AvailabilityManager } from './AvailabilityManager.jsx';
import { Legend, WeekAgenda, WeekGrid } from './WeekGrid.jsx';
import { ClinicVisitRow, OperationsBoundary } from '../clinics/ClinicVisits.jsx';
import { DAY_MS as ONE_DAY, dayStart, useClinicDay } from '../clinics/clinicWork.js';
import { SelectField } from '../../components/ui/Fields.jsx';
import {
  MODE_LABELS,
  formatDateTime,
  formatDay,
  formatFee,
  formatTime,
  groupByDay,
} from './format.js';

const weekRange = () => {
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  return { from: from.toISOString(), to: new Date(from.getTime() + 8 * 86_400_000).toISOString() };
};

/** The one thing the patient can do next for an appointment, in plain words. */
function nextAction(a) {
  const detail = `/app/appointments/${a.id}`;
  switch (a.status) {
    case 'pending_payment':
      return {
        to: `/app/appointments/${a.id}/pay`,
        label: `Pay ${formatFee(a.feePaise)}`,
        icon: CreditCard,
        primary: true,
        hint: 'Pay to confirm this booking.',
      };
    case 'in_consultation':
      return {
        to: detail,
        label: 'Join consultation',
        icon: Video,
        primary: true,
        hint: 'Your doctor has started the consultation.',
      };
    case 'confirmed':
      return a.mode === 'online'
        ? { hint: 'Join from the appointment page; the waiting room opens 15 minutes before.' }
        : { hint: 'Check in at the clinic reception when you arrive.' };
    case 'completed':
      return {
        to: detail,
        label: 'Visit summary',
        icon: ClipboardList,
        hint: 'Summary, prescription and follow-up.',
      };
    default:
      return {};
  }
}

// ── Patient ────────────────────────────────────────────────────────

function PatientAppointments() {
  const location = useLocation();
  const [params] = useSearchParams();
  const patientId = params.get('patientId') ?? undefined;
  const [scope, setScope] = useState('upcoming');
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: ['appointments', patientId, scope],
    queryFn: () => schedulingApi.mine({ patientId, scope }),
  });
  const cancel = useMutation({
    mutationFn: (id) => schedulingApi.cancel(id, 'patient_request'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['appointments'] }),
  });
  const { confirm, dialog } = useConfirm();
  const confirmCancel = async (a) => {
    const ok = await confirm({
      title: 'Cancel this appointment?',
      description: `${formatDateTime(a.startsAt)} with ${a.doctor?.professionalName ?? 'your doctor'}. ${
        a.feePaise > 0
          ? 'Paid visits cancelled at least 24 hours before the start are refunded in full; later cancellations are not refunded.'
          : 'You can book another time afterwards.'
      }`,
      confirmLabel: 'Cancel appointment',
      cancelLabel: 'Keep it',
      destructive: true,
      tone: 'warning',
    });
    if (ok) cancel.mutate(a.id);
  };

  return (
    <div className="space-y-6">
      {dialog}
      <PageHeader
        icon={CalendarDays}
        eyebrow="My care"
        title="Appointments"
        description="Your online and in-clinic consultations. You can book with any doctor in your care team."
        actions={
          <ButtonLink as={Link} to="/app/doctors" icon={Stethoscope}>
            Book with my doctors
          </ButtonLink>
        }
      />
      {location.state?.notice && <Alert tone="success">{location.state.notice}</Alert>}
      {cancel.isError && <Alert tone="error">{authErrorMessage(cancel.error)}</Alert>}
      <Tabs
        label="Appointments"
        value={scope}
        onChange={setScope}
        tabs={[
          ['upcoming', 'Upcoming', CalendarClock],
          ['past', 'Past & cancelled', ClipboardList],
        ]}
      />
      {list.isPending && <LoadingState label="Loading appointments" rows={2} />}
      {list.isError && <Alert tone="error">{authErrorMessage(list.error)}</Alert>}
      {list.data?.length === 0 &&
        (scope === 'upcoming' ? (
          <EmptyState
            icon={CalendarDays}
            title="No upcoming appointments"
            action={
              <ButtonLink as={Link} to="/app/doctors" icon={Stethoscope}>
                Book with my doctors
              </ButtonLink>
            }
          >
            Book an online consultation first; your doctor will tell you if you need to visit the
            clinic.
          </EmptyState>
        ) : (
          <EmptyState icon={ClipboardList} title="No past appointments">
            Completed and cancelled appointments appear here, with visit summaries.
          </EmptyState>
        ))}
      <ul className="space-y-3">
        {list.data?.map((a) => {
          const next = nextAction(a);
          return (
            <li key={a.id}>
              <Card className="transition-colors hover:border-primary/40">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="flex min-w-0 gap-3">
                    <span
                      aria-hidden="true"
                      className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary"
                    >
                      {a.mode === 'online' ? (
                        <Video className="h-5 w-5" />
                      ) : (
                        <Building2 className="h-5 w-5" />
                      )}
                    </span>
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 font-medium text-text">
                        <Link
                          to={`/app/appointments/${a.id}`}
                          className="hover:text-primary focus-visible:outline-offset-4"
                        >
                          {formatDateTime(a.startsAt)}
                        </Link>
                        <StatusBadge status={a.status} />
                        {a.paymentStatus && a.paymentStatus !== 'pending' && (
                          <StatusBadge status={a.paymentStatus} />
                        )}
                      </p>
                      <p className="mt-1 text-sm text-text-muted">
                        {a.doctor?.professionalName} · {MODE_LABELS[a.mode]}
                        {a.clinic && ` · ${a.clinic.name}`} · Ref {a.reference}
                      </p>
                      {next.hint && <p className="mt-1 text-sm text-text">{next.hint}</p>}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {next.to && (
                      <ButtonLink
                        as={Link}
                        to={next.to}
                        icon={next.icon}
                        variant={next.primary ? 'primary' : 'secondary'}
                      >
                        {next.label}
                      </ButtonLink>
                    )}
                    <ButtonLink
                      as={Link}
                      to={`/app/appointments/${a.id}`}
                      variant="ghost"
                      aria-label={`Details for ${formatDateTime(a.startsAt)}`}
                    >
                      Details
                    </ButtonLink>
                    {['confirmed', 'pending_payment'].includes(a.status) &&
                      scope === 'upcoming' && (
                        <Button
                          variant="ghost"
                          onClick={() => confirmCancel(a)}
                          disabled={cancel.isPending}
                        >
                          Cancel
                        </Button>
                      )}
                  </div>
                </div>
              </Card>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ── Doctor ─────────────────────────────────────────────────────────

function ScheduleItem({ a, now, onAction, pending }) {
  const [reason, setReason] = useState(null);
  const start = new Date(a.startsAt);
  const started = now >= start.getTime();
  const actions = [];
  if (a.status === 'confirmed' && a.mode === 'in_clinic') actions.push(['check-in', 'Check in']);
  if (['confirmed', 'checked_in'].includes(a.status) && started)
    actions.push(['complete', 'Complete']);
  if (a.status === 'confirmed' && now >= start.getTime() + 15 * 60_000)
    actions.push(['no-show', 'No-show']);
  // The server refuses cancellation once the appointment has started.
  if (['confirmed', 'pending_payment'].includes(a.status) && !started)
    actions.push(['cancel', 'Cancel']);
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div>
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-text">
          <span className="tabular-nums">{formatTime(a.startsAt)}</span> ·{' '}
          {a.patient?.fullName ?? `Ref ${a.reference}`} <StatusBadge status={a.status} />
        </p>
        <p className="text-xs text-text-subtle">
          {MODE_LABELS[a.mode]}
          {a.clinic && ` · ${a.clinic.name}`}
        </p>
        {reason !== null && <p className="mt-1 text-sm text-text-muted">Reason: {reason}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {reason === null && (
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => setReason((await schedulingApi.get(a.id)).reason ?? '—')}
          >
            View reason
          </Button>
        )}
        {['confirmed', 'checked_in', 'in_consultation', 'completed'].includes(a.status) && (
          <ButtonLink
            as={Link}
            to={`/app/appointments/${a.id}/consultation`}
            variant="secondary"
            size="sm"
            icon={a.status === 'completed' ? ClipboardList : Video}
          >
            {a.status === 'completed' ? 'Summary' : 'Consultation'}
          </ButtonLink>
        )}
        {['pending_payment', 'confirmed', 'checked_in', 'in_consultation'].includes(a.status) && (
          <ButtonLink
            as={Link}
            to={`/app/appointments/${a.id}/brief`}
            variant="ai"
            size="sm"
            icon={Sparkles}
          >
            AI brief
          </ButtonLink>
        )}
        {actions.map(([action, label]) => (
          <Button
            key={action}
            variant={action === 'cancel' ? 'ghost' : 'secondary'}
            size="sm"
            disabled={pending}
            onClick={() => onAction(a.id, action)}
          >
            {label}
          </Button>
        ))}
      </div>
    </li>
  );
}

const GONE = ['cancelled', 'expired'];

function DoctorSchedule() {
  const queryClient = useQueryClient();
  const [range] = useState(weekRange);
  // Captured once per mount: time-dependent actions must not make rendering impure.
  const [now] = useState(() => Date.now());
  const schedule = useQuery({
    queryKey: ['doctor-schedule'],
    queryFn: () => schedulingApi.doctorSchedule(range.from, range.to),
  });
  const act = useMutation({
    mutationFn: ({ id, action }) =>
      action === 'cancel'
        ? schedulingApi.cancel(id, 'doctor_unavailable')
        : schedulingApi.action(id, action),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['doctor-schedule'] }),
  });
  const days = groupByDay(schedule.data ?? []);
  const { confirm, dialog } = useConfirm();
  const onAction = async (id, action) => {
    if (action === 'cancel' || action === 'no-show') {
      const ok = await confirm(
        action === 'cancel'
          ? {
              title: 'Cancel this appointment?',
              description:
                'The patient is notified and any payment is refunded in full. This cannot be undone.',
              confirmLabel: 'Cancel appointment',
              cancelLabel: 'Keep it',
              destructive: true,
              tone: 'warning',
            }
          : {
              title: 'Mark as no-show?',
              description: 'Use this only when the patient did not attend.',
              confirmLabel: 'Mark no-show',
              destructive: true,
            },
      );
      if (!ok) return;
    }
    act.mutate({ id, action });
  };
  return (
    <div className="space-y-4">
      {dialog}
      {act.isError && <Alert tone="error">{authErrorMessage(act.error)}</Alert>}
      {schedule.isPending && <LoadingState label="Loading schedule" rows={2} />}
      {schedule.data?.length === 0 && (
        <EmptyState icon={CalendarDays} title="No appointments in the next week">
          New bookings appear here as patients book from your published hours. Check “Hours & time
          off” to make sure they are up to date.
        </EmptyState>
      )}
      {days.map(([key, items]) => (
        <Card key={key}>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-text">
            <CalendarDays aria-hidden="true" className="h-4 w-4 text-primary" />
            {formatDay(items[0].startsAt)}
          </h2>
          <ul className="mt-2 divide-y divide-border">
            {items
              .filter((a) => !GONE.includes(a.status))
              .map((a) => (
                <ScheduleItem
                  key={a.id}
                  a={a}
                  now={now}
                  pending={act.isPending}
                  onAction={onAction}
                />
              ))}
          </ul>
          {items.some((a) => GONE.includes(a.status)) && (
            <details className="mt-2 border-t border-border pt-2">
              <summary className="cursor-pointer text-sm text-text-muted">
                Cancelled or released ({items.filter((a) => GONE.includes(a.status)).length})
              </summary>
              <ul className="mt-1 divide-y divide-border opacity-80">
                {items
                  .filter((a) => GONE.includes(a.status))
                  .map((a) => (
                    <ScheduleItem key={a.id} a={a} now={now} pending onAction={onAction} />
                  ))}
              </ul>
            </details>
          )}
        </Card>
      ))}
    </div>
  );
}

const DAY_MS = 86_400_000;
const mondayOf = (d) => {
  const m = new Date(d);
  m.setHours(0, 0, 0, 0);
  m.setDate(m.getDate() - ((m.getDay() + 6) % 7));
  return m;
};

function DoctorWeek() {
  const [weekStart, setWeekStart] = useState(() => mondayOf(new Date()));
  const weekEnd = new Date(weekStart.getTime() + 7 * DAY_MS);
  const appts = useQuery({
    queryKey: ['doctor-schedule', 'week', weekStart.toISOString()],
    queryFn: () => schedulingApi.doctorSchedule(weekStart.toISOString(), weekEnd.toISOString()),
  });
  const rules = useQuery({ queryKey: ['availability'], queryFn: schedulingApi.rules });
  const timeOff = useQuery({ queryKey: ['time-off'], queryFn: schedulingApi.timeOff });
  const data = {
    weekStart,
    rules: rules.data ?? [],
    appointments: appts.data ?? [],
    timeOff: timeOff.data ?? [],
  };
  const fmt = (d) => new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' }).format(d);
  const booked = (appts.data ?? []).filter((a) =>
    ['confirmed', 'checked_in', 'in_consultation', 'completed'].includes(a.status),
  ).length;
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            aria-label="Previous week"
            onClick={() => setWeekStart(new Date(weekStart.getTime() - 7 * DAY_MS))}
          >
            ‹
          </Button>
          <h2 className="min-w-40 text-center text-base font-semibold text-text">
            {fmt(weekStart)} – {fmt(new Date(weekEnd.getTime() - DAY_MS))}
          </h2>
          <Button
            variant="secondary"
            size="sm"
            aria-label="Next week"
            onClick={() => setWeekStart(new Date(weekStart.getTime() + 7 * DAY_MS))}
          >
            ›
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setWeekStart(mondayOf(new Date()))}>
            This week
          </Button>
        </div>
        <p className="text-sm text-text-muted">
          {appts.isSuccess ? `${booked} booked this week` : 'Loading…'}
        </p>
      </div>
      <div className="mt-4">
        <Legend />
      </div>
      {(appts.isError || rules.isError) && (
        <Alert tone="error" className="mt-4">
          {authErrorMessage(appts.error ?? rules.error)}
        </Alert>
      )}
      <div className="mt-4 hidden md:block">
        <WeekGrid {...data} />
      </div>
      <div className="mt-4 md:hidden">
        <WeekAgenda {...data} />
      </div>
      <p className="mt-3 text-xs text-text-subtle">
        Open any appointment to see the patient and start the consultation. Change hours or add time
        off under “Hours &amp; time off”.
      </p>
    </Card>
  );
}

const DOCTOR_TABS = ['week', 'list', 'availability'];

function DoctorAppointments() {
  const [params, setParams] = useSearchParams();
  const tab = DOCTOR_TABS.includes(params.get('tab')) ? params.get('tab') : 'week';
  return (
    <div className="space-y-6">
      <PageHeader
        icon={CalendarDays}
        eyebrow="Clinical work"
        title="Schedule"
        description="Your week at a glance: published hours, booked consultations, payment holds and time off."
      />
      <Tabs
        label="Schedule"
        value={tab}
        onChange={(t) => setParams(t === 'week' ? {} : { tab: t }, { replace: true })}
        tabs={[
          ['week', 'Week', CalendarDays],
          ['list', 'Appointments', ClipboardList],
          ['availability', 'Hours & time off', CalendarClock],
        ]}
      />
      {tab === 'week' && <DoctorWeek />}
      {tab === 'list' && <DoctorSchedule />}
      {tab === 'availability' && <AvailabilityManager />}
    </div>
  );
}

// ── Clinic administrator ──────────────────────────────────────────

const CLINIC_FILTERS = [
  ['all', 'All'],
  ['upcoming', 'To come'],
  ['arrived', 'Checked in'],
  ['done', 'Completed'],
  ['cancelled', 'Cancelled'],
];
const matchesFilter = (a, f) =>
  f === 'all' ||
  (f === 'upcoming' && ['pending_payment', 'confirmed'].includes(a.status)) ||
  (f === 'arrived' && ['checked_in', 'in_consultation'].includes(a.status)) ||
  (f === 'done' && ['completed', 'no_show'].includes(a.status)) ||
  (f === 'cancelled' && ['cancelled', 'expired'].includes(a.status));

function ClinicBoard({ clinicId }) {
  const [now] = useState(() => Date.now());
  const [day, setDay] = useState(() => dayStart(now));
  const [doctor, setDoctor] = useState('');
  const [filter, setFilter] = useState('all');
  const board = useClinicDay(clinicId, day);
  const all = [...(board.data ?? [])].sort((x, y) => x.startsAt.localeCompare(y.startsAt));
  const doctors = [...new Map(all.map((a) => [a.doctorId, a.doctor?.professionalName])).entries()];
  const shown = all.filter((a) => (!doctor || a.doctorId === doctor) && matchesFilter(a, filter));
  const isToday = day.getTime() === dayStart(now).getTime();
  const move = (days) => {
    setDay(new Date(day.getTime() + days * ONE_DAY));
    setDoctor('');
  };
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" aria-label="Previous day" onClick={() => move(-1)}>
            ‹
          </Button>
          <h2 className="min-w-48 text-center text-base font-semibold text-text">
            {isToday ? 'Today, ' : ''}
            {formatDay(day.toISOString())}
          </h2>
          <Button variant="secondary" size="sm" aria-label="Next day" onClick={() => move(1)}>
            ›
          </Button>
          {!isToday && (
            <Button variant="ghost" size="sm" onClick={() => setDay(dayStart(now))}>
              Today
            </Button>
          )}
        </div>
        <SelectField
          label="Doctor"
          className="min-w-52"
          value={doctor}
          placeholder="All doctors"
          onChange={(e) => setDoctor(e.target.value)}
          options={doctors.map(([id, name]) => ({ value: id, label: name ?? 'Doctor' }))}
        />
      </div>
      <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Show">
        {CLINIC_FILTERS.map(([key, label]) => (
          <Button
            key={key}
            size="sm"
            variant={filter === key ? 'primary' : 'secondary'}
            aria-pressed={filter === key}
            onClick={() => setFilter(key)}
          >
            {label} ({all.filter((a) => matchesFilter(a, key)).length})
          </Button>
        ))}
      </div>
      <div className="mt-4">
        {board.isPending && <LoadingState label="Loading clinic schedule" rows={3} />}
        {board.isError && <Alert tone="error">{authErrorMessage(board.error)}</Alert>}
        {board.isSuccess && shown.length === 0 && (
          <EmptyState compact icon={CalendarDays} title="No appointments to show">
            {all.length
              ? 'Nothing matches these filters. Choose “All” to see every appointment that day.'
              : 'No appointments are booked with your clinic’s doctors on this day.'}
          </EmptyState>
        )}
        {shown.length > 0 && (
          <ul className="divide-y divide-border rounded-xl border border-border">
            {shown.map((a) => (
              <ClinicVisitRow key={a.id} a={a} now={now} />
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function ClinicAppointments({ clinicIds }) {
  return (
    <div className="space-y-6">
      <PageHeader
        icon={CalendarDays}
        eyebrow="Clinic"
        title="Clinic schedule"
        description="Every appointment with your clinic’s doctors, day by day: check patients in, follow payments and handle refunds or cancellations."
      />
      <OperationsBoundary compact />
      {clinicIds.length === 0 && (
        <EmptyState icon={CalendarDays} title="No clinic assigned yet">
          A HealthBridge platform administrator appoints clinic administrators to a clinic.
        </EmptyState>
      )}
      {clinicIds.map((id) => (
        <ClinicBoard key={id} clinicId={id} />
      ))}
    </div>
  );
}

export function AppointmentsPage() {
  const { user } = useAuth();
  const role = primaryRole(user.roles);
  const clinicIds = [
    ...new Set(
      (user.clinicRoles ?? []).filter((g) => g.role === 'CLINIC_ADMIN').map((g) => g.clinicId),
    ),
  ];
  if (role === 'DOCTOR') return <DoctorAppointments />;
  if (role === 'CLINIC_ADMIN') return <ClinicAppointments clinicIds={clinicIds} />;
  if (role === 'PATIENT') return <PatientAppointments />;
  return (
    <PermissionNotice title="No appointment view for your role">
      Support staff can look up accounts under User lookup. Appointment details stay with the
      patient, their doctor and the clinic.
    </PermissionNotice>
  );
}
