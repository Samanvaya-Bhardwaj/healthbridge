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
  CalendarDays,
  ClipboardList,
  Sparkles,
  Stethoscope,
  Video,
} from 'lucide-react';
import { AvailabilityManager } from './AvailabilityManager.jsx';
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
        {list.data?.map((a) => (
          <li key={a.id}>
            <Card>
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
                      {formatDateTime(a.startsAt)} <StatusBadge status={a.status} />
                      {a.paymentStatus && a.paymentStatus !== 'pending' && (
                        <span className="text-xs font-normal text-text-muted">
                          Payment: <StatusBadge status={a.paymentStatus} />
                        </span>
                      )}
                    </p>
                    <p className="mt-1 text-sm text-text-muted">
                      {a.doctor?.professionalName} · {MODE_LABELS[a.mode]}
                      {a.clinic && ` · ${a.clinic.name}`} · Ref {a.reference}
                    </p>
                  </div>
                </div>
                {(a.status === 'in_consultation' ||
                  a.status === 'completed' ||
                  (a.status === 'confirmed' && a.mode === 'online')) && (
                  <ButtonLink
                    as={Link}
                    to={`/app/appointments/${a.id}/consultation`}
                    variant={a.status === 'in_consultation' ? 'primary' : 'secondary'}
                    icon={a.status === 'completed' ? ClipboardList : Video}
                  >
                    {a.status === 'completed'
                      ? 'Visit summary'
                      : a.status === 'in_consultation'
                        ? 'Join consultation'
                        : 'Waiting room'}
                  </ButtonLink>
                )}
                {['confirmed', 'pending_payment'].includes(a.status) && scope === 'upcoming' && (
                  <div className="flex flex-wrap gap-2">
                    {a.status === 'pending_payment' && (
                      <ButtonLink as={Link} to={`/app/appointments/${a.id}/pay`}>
                        Pay {formatFee(a.feePaise)}
                      </ButtonLink>
                    )}
                    <ButtonLink
                      as={Link}
                      to={`/app/appointments/book?rescheduleId=${a.id}&doctorId=${a.doctorId}&mode=${a.mode}`}
                      variant="secondary"
                    >
                      Reschedule
                    </ButtonLink>
                    <Button
                      variant="ghost"
                      onClick={() => confirmCancel(a)}
                      disabled={cancel.isPending}
                    >
                      Cancel
                    </Button>
                  </div>
                )}
              </div>
            </Card>
          </li>
        ))}
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
  if (['confirmed', 'pending_payment'].includes(a.status)) actions.push(['cancel', 'Cancel']);
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
            variant="subtle"
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
          New bookings appear here as patients book from your availability. Check the Availability
          tab to make sure your hours are up to date.
        </EmptyState>
      )}
      {days.map(([key, items]) => (
        <Card key={key}>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-text">
            <CalendarDays aria-hidden="true" className="h-4 w-4 text-primary" />
            {formatDay(items[0].startsAt)}
          </h2>
          <ul className="mt-2 divide-y divide-border">
            {items.map((a) => (
              <ScheduleItem
                key={a.id}
                a={a}
                now={now}
                pending={act.isPending}
                onAction={onAction}
              />
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}

function DoctorAppointments() {
  const [tab, setTab] = useState('schedule');
  return (
    <div className="space-y-6">
      <PageHeader
        icon={CalendarDays}
        eyebrow="Clinical work"
        title="Schedule"
        description="Your appointments for the next week, and the hours when patients can book you."
      />
      <Tabs
        label="Appointments"
        value={tab}
        onChange={setTab}
        tabs={[
          ['schedule', 'Appointments', CalendarDays],
          ['availability', 'Availability', CalendarClock],
        ]}
      />
      {tab === 'schedule' ? <DoctorSchedule /> : <AvailabilityManager />}
    </div>
  );
}

// ── Clinic administrator ──────────────────────────────────────────

function ClinicBoard({ clinicId }) {
  const queryClient = useQueryClient();
  const [range] = useState(weekRange);
  const board = useQuery({
    queryKey: ['clinic-board', clinicId],
    queryFn: () => schedulingApi.clinicSchedule(clinicId, range.from, range.to),
  });
  const act = useMutation({
    mutationFn: ({ id, action }) =>
      action === 'cancel'
        ? schedulingApi.cancel(id, 'clinic_closed')
        : schedulingApi.action(id, action),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['clinic-board', clinicId] }),
  });
  const { confirm, dialog } = useConfirm();
  const cancelVisit = async (a) => {
    const ok = await confirm({
      title: 'Cancel this appointment?',
      description: `Ref ${a.reference} with ${a.doctor?.professionalName ?? 'the doctor'}. The patient is notified and any payment is refunded in full.`,
      confirmLabel: 'Cancel appointment',
      cancelLabel: 'Keep it',
      destructive: true,
      tone: 'warning',
    });
    if (ok) act.mutate({ id: a.id, action: 'cancel' });
  };
  return (
    <Card>
      {dialog}
      {act.isError && (
        <Alert tone="error" className="mb-4">
          {authErrorMessage(act.error)}
        </Alert>
      )}
      {board.isPending && <LoadingState label="Loading clinic schedule" rows={2} />}
      {board.data?.length === 0 && (
        <EmptyState compact icon={CalendarDays} title="No appointments in the next week">
          Visits booked with your clinic’s doctors appear here.
        </EmptyState>
      )}
      <ul className="divide-y divide-border">
        {board.data?.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <PersonIdentity
                name={a.doctor?.professionalName ?? 'Doctor'}
                detail={`${formatDateTime(a.startsAt)} · ${MODE_LABELS[a.mode]} · Ref ${a.reference}`}
                size="sm"
              />
              <StatusBadge status={a.status} />
            </div>
            <div className="flex gap-2">
              {a.status === 'confirmed' && a.mode === 'in_clinic' && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => act.mutate({ id: a.id, action: 'check-in' })}
                >
                  Check in
                </Button>
              )}
              {['confirmed', 'pending_payment'].includes(a.status) && (
                <Button variant="ghost" size="sm" onClick={() => cancelVisit(a)}>
                  Cancel
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
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
        description="Every appointment at your clinic for the next week. Patients identify themselves at the desk with their booking reference; patient details and visit reasons are visible only to the patient and their doctor."
      />
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
