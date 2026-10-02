import { useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/authContext.js';
import { primaryRole } from '../../app/navigation.js';
import { schedulingApi } from '../../lib/domainApi.js';
import { authErrorMessage } from '../auth/errorMessages.js';
import { Card } from '../../components/ui/Card.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { StatusBadge } from '../../components/ui/Badge.jsx';
import { Skeleton } from '../../components/ui/Skeleton.jsx';
import { EmptyState } from '../../components/ui/EmptyState.jsx';
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

function Tabs({ tabs, value, onChange, label }) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 border-b border-border">
      {tabs.map(([key, text]) => (
        <button
          key={key}
          role="tab"
          aria-selected={value === key}
          onClick={() => onChange(key)}
          className={`min-h-11 px-4 text-sm font-medium ${value === key ? 'border-b-2 border-primary text-primary' : 'text-text-muted hover:text-text'}`}
        >
          {text}
        </button>
      ))}
    </div>
  );
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

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-text">Appointments</h1>
          <p className="mt-2 text-text-muted">Book with a doctor from your care team.</p>
        </div>
        <Link
          to="/app/doctors"
          className="min-h-11 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-contrast hover:bg-primary-hover"
        >
          Book with my doctors
        </Link>
      </div>
      {location.state?.notice && <Alert tone="success">{location.state.notice}</Alert>}
      {cancel.isError && <Alert tone="error">{authErrorMessage(cancel.error)}</Alert>}
      <Tabs
        label="Appointments"
        value={scope}
        onChange={setScope}
        tabs={[
          ['upcoming', 'Upcoming'],
          ['past', 'Past & cancelled'],
        ]}
      />
      {list.isPending && <Skeleton className="h-24 w-full" />}
      {list.isError && <Alert tone="error">{authErrorMessage(list.error)}</Alert>}
      {list.data?.length === 0 && (
        <EmptyState title={scope === 'upcoming' ? 'No upcoming appointments' : 'Nothing here yet'}>
          Your appointments with your doctors appear here.
        </EmptyState>
      )}
      <ul className="space-y-3">
        {list.data?.map((a) => (
          <li key={a.id}>
            <Card>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
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
                {['confirmed', 'pending_payment'].includes(a.status) && scope === 'upcoming' && (
                  <div className="flex flex-wrap gap-2">
                    {a.status === 'pending_payment' && (
                      <Link
                        to={`/app/appointments/${a.id}/pay`}
                        className="min-h-11 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-contrast hover:bg-primary-hover"
                      >
                        Pay {formatFee(a.feePaise)}
                      </Link>
                    )}
                    <Link
                      to={`/app/appointments/book?rescheduleId=${a.id}&doctorId=${a.doctorId}&mode=${a.mode}`}
                      className="min-h-11 rounded-lg border border-border px-4 py-2.5 text-sm font-medium text-text hover:bg-surface-muted"
                    >
                      Reschedule
                    </Link>
                    <Button
                      variant="ghost"
                      onClick={() => cancel.mutate(a.id)}
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
        <p className="flex items-center gap-2 text-sm font-medium text-text">
          {formatTime(a.startsAt)} · {a.patient?.fullName ?? `Ref ${a.reference}`}{' '}
          <StatusBadge status={a.status} />
        </p>
        <p className="text-xs text-text-subtle">
          {MODE_LABELS[a.mode]}
          {a.clinic && ` · ${a.clinic.name}`}
        </p>
        {reason !== null && <p className="mt-1 text-sm text-text-muted">Reason: {reason}</p>}
      </div>
      <div className="flex flex-wrap gap-2">
        {reason === null && (
          <Button
            variant="ghost"
            onClick={async () => setReason((await schedulingApi.get(a.id)).reason ?? '—')}
          >
            View reason
          </Button>
        )}
        {actions.map(([action, label]) => (
          <Button
            key={action}
            variant={action === 'cancel' ? 'ghost' : 'secondary'}
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
  return (
    <div className="space-y-4">
      {act.isError && <Alert tone="error">{authErrorMessage(act.error)}</Alert>}
      {schedule.isPending && <Skeleton className="h-24 w-full" />}
      {schedule.data?.length === 0 && (
        <EmptyState title="No appointments this week">New bookings appear here.</EmptyState>
      )}
      {days.map(([key, items]) => (
        <Card key={key}>
          <h2 className="text-sm font-semibold text-text">{formatDay(items[0].startsAt)}</h2>
          <ul className="mt-2 divide-y divide-border">
            {items.map((a) => (
              <ScheduleItem
                key={a.id}
                a={a}
                now={now}
                pending={act.isPending}
                onAction={(id, action) => act.mutate({ id, action })}
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
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-text">Appointments</h1>
        <p className="mt-2 text-text-muted">
          Your schedule for the next week, and when patients can book you.
        </p>
      </div>
      <Tabs
        label="Appointments"
        value={tab}
        onChange={setTab}
        tabs={[
          ['schedule', 'Schedule'],
          ['availability', 'Availability'],
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
  return (
    <Card>
      {act.isError && (
        <Alert tone="error" className="mb-4">
          {authErrorMessage(act.error)}
        </Alert>
      )}
      {board.isPending && <Skeleton className="h-16 w-full" />}
      {board.data?.length === 0 && (
        <p className="text-sm text-text-muted">No appointments this week.</p>
      )}
      <ul className="divide-y divide-border">
        {board.data?.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div>
              <p className="flex items-center gap-2 text-sm font-medium text-text">
                {formatDateTime(a.startsAt)} · Ref {a.reference} <StatusBadge status={a.status} />
              </p>
              <p className="text-xs text-text-subtle">
                {a.doctor?.professionalName} · {MODE_LABELS[a.mode]}
              </p>
            </div>
            <div className="flex gap-2">
              {a.status === 'confirmed' && a.mode === 'in_clinic' && (
                <Button
                  variant="secondary"
                  onClick={() => act.mutate({ id: a.id, action: 'check-in' })}
                >
                  Check in
                </Button>
              )}
              {['confirmed', 'pending_payment'].includes(a.status) && (
                <Button variant="ghost" onClick={() => act.mutate({ id: a.id, action: 'cancel' })}>
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
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-text">Clinic appointments</h1>
        <p className="mt-2 text-text-muted">
          Patients identify themselves at the desk with their booking reference. Patient details and
          visit reasons are visible only to the patient and their doctor.
        </p>
      </div>
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
    <EmptyState title="Appointment lookup is not available yet">
      Support tools for appointments arrive with the support console.
    </EmptyState>
  );
}
