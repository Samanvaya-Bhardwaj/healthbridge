import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  BOOKING_HORIZON_DAYS,
  PATIENT_FULL_REFUND_HOURS,
  PAYMENT_HOLD_MINUTES,
} from '@healthbridge/shared';
import { schedulingApi } from '../../lib/domainApi.js';
import { authErrorMessage } from '../auth/errorMessages.js';
import { Card } from '../../components/ui/Card.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { Button, ButtonLink } from '../../components/ui/Button.jsx';
import { TextAreaField } from '../../components/ui/Fields.jsx';
import { EmptyState, LoadingState } from '../../components/ui/EmptyState.jsx';
import { PersonIdentity } from '../../components/ui/Identity.jsx';
import { PageHeader } from '../../components/ui/Typography.jsx';
import { BackLink } from '../../components/ui/BackLink.jsx';
import { CalendarPlus, CalendarX, Info, Stethoscope } from 'lucide-react';
import { MODE_LABELS, formatDay, formatFee, formatTime, groupByDay, localDate } from './format.js';
import {
  AVAILABILITY_DAYS,
  MODE_DESCRIPTIONS,
  MODE_ICONS,
  feeText,
  summariseSlots,
  useDoctorProfile,
} from '../care/doctorInfo.js';

const dayParts = (slots) => {
  const parts = [
    ['Morning', []],
    ['Afternoon', []],
    ['Evening', []],
  ];
  for (const slot of slots) {
    const h = new Date(slot.startsAt).getHours();
    parts[h < 12 ? 0 : h < 17 ? 1 : 2][1].push(slot);
  }
  return parts.filter(([, list]) => list.length);
};

const slotMinutes = (slot) =>
  slot ? Math.round((new Date(slot.endsAt) - new Date(slot.startsAt)) / 60_000) : 0;

function Step({ number, title, hint, done, children }) {
  return (
    <Card>
      <fieldset className="min-w-0">
        <legend className="flex items-center gap-3 text-base font-semibold text-text">
          <span
            aria-hidden="true"
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm ${
              done ? 'bg-primary text-primary-contrast' : 'bg-primary-soft text-primary'
            }`}
          >
            {number}
          </span>
          <span>
            <span className="sr-only">Step {number}: </span>
            {title}
          </span>
        </legend>
        {hint && <p className="mt-1 text-sm text-text-muted sm:pl-10">{hint}</p>}
        <div className="mt-4">{children}</div>
      </fieldset>
    </Card>
  );
}

/** Day picker: a radio group (arrow keys move between days, one tab stop). */
function DayPicker({ days, value, onChange }) {
  const refs = useRef([]);
  const index = Math.max(
    0,
    days.findIndex(([key]) => key === value),
  );
  const move = (next) => {
    const i = (next + days.length) % days.length;
    onChange(days[i][0]);
    refs.current[i]?.focus();
  };
  return (
    <div role="radiogroup" aria-label="Date" className="flex gap-2 overflow-x-auto pb-1">
      {days.map(([key, items], i) => {
        const d = new Date(items[0].startsAt);
        const selected = key === value;
        return (
          <button
            key={key}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={`${formatDay(items[0].startsAt)}, ${items.length} time${items.length === 1 ? '' : 's'} free`}
            tabIndex={i === index ? 0 : -1}
            onClick={() => onChange(key)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') move(i + 1);
              else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') move(i - 1);
              else if (e.key === 'Home') move(0);
              else if (e.key === 'End') move(days.length - 1);
              else return;
              e.preventDefault();
            }}
            className={`flex min-h-16 w-16 shrink-0 flex-col items-center justify-center rounded-xl border text-sm ${
              selected
                ? 'border-primary bg-primary text-primary-contrast'
                : 'border-border text-text hover:border-primary/40'
            }`}
          >
            <span className="text-xs">
              {new Intl.DateTimeFormat('en-IN', { weekday: 'short' }).format(d)}
            </span>
            <span className="text-lg font-semibold leading-tight">{d.getDate()}</span>
            <span className="text-xs">
              {new Intl.DateTimeFormat('en-IN', { month: 'short' }).format(d)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function SummaryRows({ doctorName, mode, slot, clinicName, rescheduling }) {
  const rows = [
    ['Doctor', doctorName],
    ['Type', mode ? MODE_LABELS[mode] : 'Not chosen yet'],
    ...(mode === 'in_clinic' && clinicName ? [['Where', clinicName]] : []),
    ['Date', slot ? formatDay(slot.startsAt) : 'Not chosen yet'],
    ['Time', slot ? `${formatTime(slot.startsAt)} (${slotMinutes(slot)} min)` : 'Not chosen yet'],
    ...(rescheduling ? [] : [['Fee', slot ? formatFee(slot.feePaise) : '—']]),
  ];
  return (
    <dl className="divide-y divide-border text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="flex justify-between gap-3 py-2">
          <dt className="text-text-muted">{label}</dt>
          <dd className="text-right font-medium text-text">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** What happens after booking: only rules the platform actually applies. */
function Policies({ slot, mode, rescheduling }) {
  const items = [];
  if (!rescheduling && slot?.feePaise > 0) {
    items.push(
      `Your time is held for ${PAYMENT_HOLD_MINUTES} minutes while you pay on the next step.`,
      `Cancel at least ${PATIENT_FULL_REFUND_HOURS} hours before the start for a full refund. Later cancellations are not refunded.`,
    );
  } else if (!rescheduling && slot) {
    items.push('This consultation has no fee. You can cancel or reschedule before it starts.');
  }
  if (mode === 'online') {
    items.push(
      'You join from the appointment page. The waiting room opens 15 minutes before the start.',
    );
  } else if (mode === 'in_clinic') {
    items.push('At the clinic, check in at reception (from one hour before the start).');
  }
  return (
    <ul className="space-y-1.5 text-sm text-text-muted">
      {items.map((text) => (
        <li key={text} className="flex gap-2">
          <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          {text}
        </li>
      ))}
    </ul>
  );
}

/**
 * Booking flow, one decision at a time: consultation type → date → time → reason →
 * confirm (and pay). Reached from My Doctors; the server also requires an active care
 * relationship. `rescheduleId` reuses the flow to move an existing appointment.
 */
export function BookAppointmentPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const doctorId = params.get('doctorId');
  const patientId = params.get('patientId');
  const rescheduleId = params.get('rescheduleId');
  const [mode, setMode] = useState(params.get('mode'));
  const [day, setDay] = useState(null);
  const [selected, setSelected] = useState(null);
  const [reason, setReason] = useState('');
  // One idempotency key per booking attempt: retries never create duplicates.
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const doctor = useDoctorProfile(doctorId);
  const slots = useQuery({
    queryKey: ['slots', doctorId, 'booking'],
    queryFn: () =>
      schedulingApi.slots(doctorId, { from: localDate(0), to: localDate(AVAILABILITY_DAYS) }),
    enabled: Boolean(doctorId),
    retry: false,
  });
  const modes = useMemo(() => summariseSlots(slots.data), [slots.data]);
  // A requested mode, or the only mode with free times, is pre-selected.
  const activeMode =
    (mode && modes.some((m) => m.mode === mode) ? mode : null) ??
    (modes.length === 1 ? modes[0].mode : null);
  const modeSlots = useMemo(
    () => (slots.data ?? []).filter((s) => s.mode === activeMode),
    [slots.data, activeMode],
  );
  const days = useMemo(() => groupByDay(modeSlots), [modeSlots]);
  const activeDay = day && days.some(([k]) => k === day) ? day : (days[0]?.[0] ?? null);
  const daySlots = days.find(([k]) => k === activeDay)?.[1] ?? [];
  const clinicName = (id) => doctor.data?.clinics?.find((c) => c.id === id)?.name;

  const submit = useMutation({
    mutationFn: () =>
      rescheduleId
        ? schedulingApi.reschedule(rescheduleId, selected.startsAt)
        : schedulingApi.book(
            {
              patientId,
              doctorId,
              startsAt: selected.startsAt,
              mode: activeMode,
              ...(selected.clinicId ? { clinicId: selected.clinicId } : {}),
              reason,
            },
            idempotencyKey,
          ),
    onSuccess: (appointment) =>
      appointment?.status === 'pending_payment'
        ? navigate(`/app/appointments/${appointment.id}/pay`)
        : navigate(`/app/appointments/${appointment.id}`, {
            state: { notice: rescheduleId ? 'Appointment rescheduled.' : 'Appointment booked.' },
          }),
  });

  if (!doctorId || (!patientId && !rescheduleId)) {
    return (
      <EmptyState
        icon={Stethoscope}
        title="Choose a doctor to book with"
        action={
          <ButtonLink as={Link} to="/app/doctors" icon={Stethoscope}>
            Go to My Doctors
          </ButtonLink>
        }
      >
        You book with doctors in your care team. Open My Doctors and choose “Book a consultation”
        next to the doctor you want to see.
      </EmptyState>
    );
  }

  const doctorName = doctor.data?.professionalName ?? 'Your doctor';
  const reasonOk = Boolean(rescheduleId) || reason.trim().length >= 3;
  const ready = Boolean(selected) && reasonOk;
  const n = rescheduleId
    ? { date: 1, time: 2, confirm: 3 }
    : { type: 1, date: 2, time: 3, reason: 4, confirm: 5 };
  const summary = (
    <SummaryRows
      doctorName={doctorName}
      mode={activeMode}
      slot={selected}
      clinicName={selected?.clinicId ? clinicName(selected.clinicId) : undefined}
      rescheduling={Boolean(rescheduleId)}
    />
  );

  return (
    <div className="space-y-6">
      <BackLink to={rescheduleId ? `/app/appointments/${rescheduleId}` : '/app/doctors'}>
        {rescheduleId ? 'Appointment' : 'My Doctors'}
      </BackLink>
      <PageHeader
        icon={CalendarPlus}
        eyebrow="My care"
        title={rescheduleId ? 'Choose a new time' : 'Book a consultation'}
        description={
          rescheduleId
            ? `Pick another time with ${doctorName}. Your current booking stays until you confirm.`
            : `With ${doctorName}${doctor.data ? ` · ${doctor.data.primarySpecialization}` : ''}. Online first is usually quickest; your doctor will tell you if you need to visit.`
        }
      />
      {slots.isPending && <LoadingState label="Loading available times" rows={3} />}
      {slots.isError && <Alert tone="error">{authErrorMessage(slots.error)}</Alert>}
      {slots.isSuccess && modes.length === 0 && (
        <EmptyState
          icon={CalendarX}
          title={`No free times in the next ${AVAILABILITY_DAYS} days`}
          action={
            <ButtonLink as={Link} to="/app/doctors" variant="secondary" icon={Stethoscope}>
              Back to My Doctors
            </ButtonLink>
          }
        >
          {doctorName} has no open times right now. Please check again later, or book with another
          doctor in your care team. Bookings open up to {BOOKING_HORIZON_DAYS} days ahead.
        </EmptyState>
      )}
      {slots.isSuccess && modes.length > 0 && (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="space-y-4">
            {!rescheduleId && (
              <Step
                number={n.type}
                title="Consultation type"
                hint="How would you like to see the doctor?"
                done={Boolean(activeMode)}
              >
                <div className="grid gap-3 sm:grid-cols-2">
                  {['online', 'in_clinic'].map((m) => {
                    const info = modes.find((x) => x.mode === m);
                    const Icon = MODE_ICONS[m];
                    const checked = activeMode === m;
                    return (
                      <label
                        key={m}
                        className={`flex gap-3 rounded-xl border p-4 ${
                          checked ? 'border-primary bg-primary-soft' : 'border-border'
                        } ${info ? 'cursor-pointer hover:border-primary/40' : 'cursor-not-allowed opacity-60'}`}
                      >
                        <input
                          type="radio"
                          name="mode"
                          value={m}
                          checked={checked}
                          disabled={!info}
                          onChange={() => {
                            setMode(m);
                            setDay(null);
                            setSelected(null);
                          }}
                          className="mt-1 h-4 w-4 shrink-0 accent-primary"
                        />
                        <span className="min-w-0 text-sm">
                          <span className="flex items-center gap-2 font-medium text-text">
                            <Icon aria-hidden="true" className="h-4 w-4 text-primary" />
                            {MODE_LABELS[m]}
                          </span>
                          <span className="mt-0.5 block text-text-muted">
                            {m === 'in_clinic' && info
                              ? `At ${clinicName(info.next.clinicId) ?? 'the clinic'}`
                              : MODE_DESCRIPTIONS[m]}
                          </span>
                          <span className="mt-1 block text-text">
                            {info ? feeText(info) : 'No free times in the next two weeks'}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </Step>
            )}

            {activeMode && (
              <Step number={n.date} title="Date" done={Boolean(activeDay)}>
                <DayPicker
                  days={days}
                  value={activeDay}
                  onChange={(key) => {
                    setDay(key);
                    setSelected(null);
                  }}
                />
              </Step>
            )}

            {activeMode && daySlots.length > 0 && (
              <Step
                number={n.time}
                title="Available time"
                hint={`Shown in your time zone. Each consultation is ${slotMinutes(daySlots[0])} minutes.`}
                done={Boolean(selected)}
              >
                <div className="space-y-4">
                  {dayParts(daySlots).map(([part, list]) => (
                    <div key={part}>
                      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-subtle">
                        {part}
                      </p>
                      <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                        {list.map((slot) => {
                          const on = selected?.startsAt === slot.startsAt;
                          return (
                            <button
                              key={slot.startsAt}
                              type="button"
                              onClick={() => setSelected(slot)}
                              aria-pressed={on}
                              className={`min-h-11 rounded-lg border text-sm font-medium tabular-nums ${
                                on
                                  ? 'border-primary bg-primary text-primary-contrast'
                                  : 'border-border text-text hover:border-primary/40 hover:bg-surface-muted'
                              }`}
                            >
                              {formatTime(slot.startsAt)}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </Step>
            )}

            {!rescheduleId && activeMode && (
              <Step
                number={n.reason}
                title="Reason for visit"
                hint="A sentence or two is enough. Only your doctor sees it."
                done={reason.trim().length >= 3}
              >
                <TextAreaField
                  label="Reason for visit"
                  hint="For example: “Fever and cough for three days.”"
                  rows={3}
                  maxLength={500}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </Step>
            )}

            {activeMode && (
              <Step number={n.confirm} title={rescheduleId ? 'Confirm' : 'Confirm and pay'}>
                <div className="mb-4 lg:hidden">{summary}</div>
                <Policies slot={selected} mode={activeMode} rescheduling={Boolean(rescheduleId)} />
                {submit.isError && (
                  <Alert tone="error" className="mt-4">
                    {authErrorMessage(submit.error)}
                  </Alert>
                )}
                {!ready && (
                  <p className="mt-4 text-sm text-text-muted">
                    {!selected
                      ? 'Choose a time to continue.'
                      : 'Add a short reason for your visit to continue.'}
                  </p>
                )}
                <Button
                  className="mt-4"
                  onClick={() => submit.mutate()}
                  disabled={!ready || submit.isPending}
                  loading={submit.isPending}
                >
                  {rescheduleId
                    ? 'Confirm new time'
                    : selected?.feePaise > 0
                      ? `Book and pay ${formatFee(selected.feePaise)}`
                      : 'Book appointment'}
                </Button>
              </Step>
            )}
          </div>
          <aside className="hidden lg:block" aria-label="Your appointment">
            <Card className="sticky top-6">
              <h2 className="text-base font-semibold text-text">Your appointment</h2>
              {doctor.data && (
                <div className="mt-3">
                  <PersonIdentity
                    name={doctor.data.professionalName}
                    verified
                    detail={doctor.data.primarySpecialization}
                  />
                </div>
              )}
              <div className="mt-3">{summary}</div>
            </Card>
          </aside>
        </div>
      )}
    </div>
  );
}
