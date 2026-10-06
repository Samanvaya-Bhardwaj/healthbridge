import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { TIME_OFF_REASONS } from '@healthbridge/shared';
import { Building2, CalendarOff, CalendarPlus, Clock, Trash2, Video } from 'lucide-react';
import { doctorsApi, schedulingApi } from '../../lib/domainApi.js';
import { authErrorMessage } from '../auth/errorMessages.js';
import { Card } from '../../components/ui/Card.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { SelectField, TextField } from '../../components/ui/Fields.jsx';
import { EmptyState, LoadingState } from '../../components/ui/EmptyState.jsx';
import { SectionHeader } from '../../components/ui/Typography.jsx';
import { useConfirm } from '../../components/ui/useConfirm.jsx';
import { MODE_LABELS, formatDateOnly, formatDateTime, formatFee, localDate } from './format.js';
import { overlappingRules, toMin } from './weekModel.js';
import { LoadError } from '../../components/ui/LoadError.jsx';
import { useSafeMutation } from '../../lib/useSafeMutation.js';

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const SLOT_LENGTHS = [10, 15, 20, 30, 45, 60];
const TIME_OFF_LABELS = {
  leave: 'Leave',
  conference: 'Conference',
  personal: 'Personal',
  clinic_closed: 'Clinic closed',
  other: 'Other',
};
const DAY_MS = 86_400_000;
const ACTIVE = ['pending_payment', 'confirmed', 'checked_in', 'in_consultation'];

/** Upcoming appointments (next 62 days, the longest range the schedule API serves). */
function useUpcomingAppointments() {
  const [range] = useState(() => {
    const from = new Date();
    return { from: from.toISOString(), to: new Date(from.getTime() + 62 * DAY_MS).toISOString() };
  });
  return useQuery({
    queryKey: ['doctor-schedule', 'upcoming62'],
    queryFn: () => schedulingApi.doctorSchedule(range.from, range.to),
  });
}

/** Booked appointments that a rule's window covers (by weekday and local time). */
const inRule = (a, r) => {
  const d = new Date(a.startsAt);
  const weekday = ((d.getDay() + 6) % 7) + 1;
  const min = d.getHours() * 60 + d.getMinutes();
  return (
    ACTIVE.includes(a.status) &&
    weekday === r.weekday &&
    min >= toMin(r.startTime) &&
    min < toMin(r.endTime)
  );
};

function RuleForm({ rules, clinics, onSaved }) {
  const [form, setForm] = useState({
    mode: 'online',
    clinicId: '',
    days: [1],
    startTime: '09:00',
    endTime: '12:00',
    slotMinutes: '15',
    fee: '0',
    validFrom: localDate(0),
    validUntil: '',
  });
  const [result, setResult] = useState(null);
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });
  const toggleDay = (d) =>
    setForm((f) => ({
      ...f,
      days: f.days.includes(d) ? f.days.filter((x) => x !== d) : [...f.days, d].sort(),
    }));

  const span = toMin(form.endTime) - toMin(form.startTime);
  const slots = span > 0 ? Math.floor(span / Number(form.slotMinutes)) : 0;
  const clashes = form.days.flatMap((weekday) =>
    overlappingRules(rules, { ...form, weekday }).map((r) => ({ weekday, r })),
  );
  const problems = [
    !form.days.length && 'Choose at least one day.',
    span <= 0 && 'The end time must be after the start time.',
    span > 0 && slots < 1 && 'The window must fit at least one consultation.',
    form.mode === 'in_clinic' && !form.clinicId && 'Choose the clinic for in-clinic hours.',
    form.validUntil && form.validUntil < form.validFrom && 'The end date must be after the start.',
    clashes.length > 0 &&
      `Overlaps your existing hours: ${clashes
        .map(({ weekday, r }) => `${WEEKDAYS[weekday - 1]} ${r.startTime}–${r.endTime}`)
        .join(', ')}. You can’t be in two places at once.`,
  ].filter(Boolean);

  const save = useSafeMutation({
    mutationFn: async () => {
      const outcome = [];
      // One rule per day: the server keeps its own overlap check for each.
      for (const weekday of form.days) {
        try {
          await schedulingApi.addRule({
            mode: form.mode,
            ...(form.mode === 'in_clinic' ? { clinicId: form.clinicId } : {}),
            weekday,
            startTime: form.startTime,
            endTime: form.endTime,
            slotMinutes: Number(form.slotMinutes),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            validFrom: form.validFrom,
            ...(form.validUntil ? { validUntil: form.validUntil } : {}),
            feePaise: Math.round(Number(form.fee || 0) * 100),
          });
          outcome.push([weekday, null]);
        } catch (err) {
          outcome.push([weekday, err]);
        }
      }
      return outcome;
    },
    onSuccess: (outcome) => {
      setResult(outcome);
      onSaved();
    },
  });
  const failed = (result ?? []).filter(([, err]) => err);
  const added = (result ?? []).filter(([, err]) => !err);

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        setResult(null);
        if (!problems.length) save.mutate();
      }}
    >
      <fieldset className="min-w-0">
        <legend className="text-sm font-medium text-text">Consultation type</legend>
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {['online', 'in_clinic'].map((m) => {
            const Icon = m === 'online' ? Video : Building2;
            return (
              <label
                key={m}
                className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3.5 py-3 text-sm ${
                  form.mode === m ? 'border-primary bg-primary-soft' : 'border-border'
                }`}
              >
                <input
                  type="radio"
                  name="rule-mode"
                  value={m}
                  checked={form.mode === m}
                  onChange={() => setForm({ ...form, mode: m })}
                  className="h-4 w-4 accent-primary"
                />
                <Icon aria-hidden="true" className="h-4 w-4 text-primary" />
                <span className="font-medium text-text">{MODE_LABELS[m]}</span>
              </label>
            );
          })}
        </div>
      </fieldset>
      {form.mode === 'in_clinic' && (
        <SelectField
          label="Clinic"
          placeholder={clinics.length ? 'Choose a clinic' : 'You are not a member of a clinic'}
          value={form.clinicId}
          onChange={set('clinicId')}
          options={clinics.map((m) => ({ value: m.clinicId, label: m.clinic.name }))}
        />
      )}
      <fieldset className="min-w-0">
        <legend className="text-sm font-medium text-text">Days</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {WEEKDAYS.map((d, i) => {
            const on = form.days.includes(i + 1);
            return (
              <button
                key={d}
                type="button"
                aria-pressed={on}
                onClick={() => toggleDay(i + 1)}
                className={`min-h-11 min-w-14 rounded-lg border px-3 text-sm font-medium ${
                  on
                    ? 'border-primary bg-primary text-primary-contrast'
                    : 'border-border text-text hover:border-primary/40'
                }`}
              >
                {d.slice(0, 3)}
                <span className="sr-only">{d.slice(3)}</span>
              </button>
            );
          })}
        </div>
      </fieldset>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <TextField label="From" type="time" value={form.startTime} onChange={set('startTime')} />
        <TextField label="Until" type="time" value={form.endTime} onChange={set('endTime')} />
        <SelectField
          label="Consultation length"
          value={form.slotMinutes}
          onChange={set('slotMinutes')}
          options={SLOT_LENGTHS.map((m) => ({ value: String(m), label: `${m} minutes` }))}
        />
        <TextField
          label="Fee (₹)"
          type="number"
          min="0"
          step="1"
          hint="0 for no fee"
          value={form.fee}
          onChange={set('fee')}
        />
        <TextField
          label="Starting"
          type="date"
          value={form.validFrom}
          min={localDate(0)}
          onChange={set('validFrom')}
        />
        <TextField
          label="Ending (optional)"
          type="date"
          hint="Empty: repeats every week"
          value={form.validUntil}
          onChange={set('validUntil')}
        />
      </div>
      {!problems.length && (
        <p className="rounded-lg bg-primary-soft px-4 py-3 text-sm text-text">
          {form.days.map((d) => WEEKDAYS[d - 1]).join(', ')}: {form.startTime}–{form.endTime},{' '}
          {slots} {MODE_LABELS[form.mode].toLowerCase()} consultation{slots === 1 ? '' : 's'} of{' '}
          {form.slotMinutes} minutes, {formatFee(Math.round(Number(form.fee || 0) * 100))}, from{' '}
          {formatDateOnly(form.validFrom)}
          {form.validUntil ? ` until ${formatDateOnly(form.validUntil)}` : ', every week'}.
        </p>
      )}
      {problems.length > 0 && (
        <Alert tone="warning" title="Check these first">
          <ul className="list-disc pl-5">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Alert>
      )}
      {added.length > 0 && (
        <Alert tone="success">
          Hours added for {added.map(([d]) => WEEKDAYS[d - 1]).join(', ')}. Patients can book them
          now.
        </Alert>
      )}
      {failed.length > 0 && (
        <Alert tone="error" title="Some days were not added">
          {failed.map(([d, err]) => `${WEEKDAYS[d - 1]}: ${authErrorMessage(err)}`).join(' ')}
        </Alert>
      )}
      <Button
        type="submit"
        icon={CalendarPlus}
        disabled={problems.length > 0}
        loading={save.isPending}
      >
        Add hours
      </Button>
    </form>
  );
}

function WeeklyHours({ rules, clinics, upcoming, onChanged }) {
  const archive = useSafeMutation({ mutationFn: schedulingApi.archiveRule, onSuccess: onChanged });
  const { confirm, dialog } = useConfirm();
  const clinicName = (id) => clinics.find((m) => m.clinicId === id)?.clinic.name;
  const remove = async (r) => {
    const booked = (upcoming ?? []).filter((a) => inRule(a, r)).length;
    const ok = await confirm({
      title: `Remove ${WEEKDAYS[r.weekday - 1]} ${r.startTime}–${r.endTime}?`,
      description: `Patients can no longer book these hours. ${
        booked
          ? `${booked} appointment${booked === 1 ? '' : 's'} already booked in these hours stay booked; cancel them from the schedule if you can’t attend.`
          : 'No upcoming appointments are booked in these hours.'
      }`,
      confirmLabel: 'Remove hours',
      destructive: true,
    });
    if (ok) archive.mutate(r.id);
  };
  return (
    <>
      {dialog}
      {archive.isError && <Alert tone="error">{authErrorMessage(archive.error)}</Alert>}
      {rules.length === 0 ? (
        <EmptyState compact icon={Clock} title="No hours published yet">
          Patients can book you only during the hours you publish. Add your first hours below.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border">
          {WEEKDAYS.map((day, i) => {
            const dayRules = rules
              .filter((r) => r.weekday === i + 1)
              .sort((a, b) => a.startTime.localeCompare(b.startTime));
            return (
              <li key={day} className="flex flex-wrap gap-3 py-3 sm:flex-nowrap">
                <span className="w-24 shrink-0 pt-1.5 text-sm font-medium text-text">{day}</span>
                {dayRules.length === 0 ? (
                  <span className="pt-1.5 text-sm text-text-subtle">Not available</span>
                ) : (
                  <ul className="flex min-w-0 flex-1 flex-wrap gap-2">
                    {dayRules.map((r) => {
                      const Icon = r.mode === 'online' ? Video : Building2;
                      const booked = (upcoming ?? []).filter((a) => inRule(a, r)).length;
                      return (
                        <li
                          key={r.id}
                          className="flex items-start gap-2 rounded-lg border border-primary/30 bg-primary-soft px-3 py-2 text-sm"
                        >
                          <Icon
                            aria-hidden="true"
                            className="mt-0.5 h-4 w-4 shrink-0 text-primary"
                          />
                          <span className="min-w-0">
                            <span className="block font-medium text-text">
                              {r.startTime}–{r.endTime} · {MODE_LABELS[r.mode]}
                              {r.clinicId && ` · ${clinicName(r.clinicId) ?? 'Clinic'}`}
                            </span>
                            <span className="block text-xs text-text-muted">
                              {r.slotMinutes} min · {formatFee(r.feePaise)} · from{' '}
                              {formatDateOnly(r.validFrom)}
                              {r.validUntil ? ` until ${formatDateOnly(r.validUntil)}` : ''}
                              {booked > 0 && ` · ${booked} booked`}
                            </span>
                          </span>
                          <button
                            type="button"
                            onClick={() => remove(r)}
                            disabled={archive.isPending}
                            aria-label={`Remove ${day} ${r.startTime}–${r.endTime}`}
                            className="-m-1 ml-1 inline-flex min-h-8 min-w-8 items-center justify-center rounded text-text-subtle hover:bg-surface-raised hover:text-danger"
                          >
                            <Trash2 aria-hidden="true" className="h-4 w-4" />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function TimeOff({ upcoming }) {
  const queryClient = useQueryClient();
  const list = useQuery({ queryKey: ['time-off'], queryFn: schedulingApi.timeOff });
  const [form, setForm] = useState({ startsAt: '', endsAt: '', reasonCode: 'leave' });
  const [message, setMessage] = useState(null);
  const { confirm, dialog } = useConfirm();
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['time-off'] });
    queryClient.invalidateQueries({ queryKey: ['doctor-schedule'] });
  };
  const valid = Boolean(
    form.startsAt && form.endsAt && new Date(form.endsAt) > new Date(form.startsAt),
  );
  // Appointments inside the period are shown before saving: time off never cancels them.
  const clashes = useMemo(
    () =>
      valid
        ? (upcoming ?? []).filter(
            (a) =>
              ACTIVE.includes(a.status) &&
              new Date(a.startsAt) < new Date(form.endsAt) &&
              new Date(a.endsAt) > new Date(form.startsAt),
          )
        : [],
    [valid, upcoming, form.startsAt, form.endsAt],
  );
  const add = useSafeMutation({
    mutationFn: () =>
      schedulingApi.addTimeOff({
        startsAt: new Date(form.startsAt).toISOString(),
        endsAt: new Date(form.endsAt).toISOString(),
        reasonCode: form.reasonCode,
      }),
    onSuccess: (result) => {
      setMessage({
        tone: result.clashingAppointments ? 'warning' : 'success',
        text: result.clashingAppointments
          ? `Time off added. ${result.clashingAppointments} appointment(s) in this period are still booked: open them from the schedule to cancel if you can’t attend.`
          : 'Time off added. Patients can’t book you during this period.',
      });
      setForm({ startsAt: '', endsAt: '', reasonCode: form.reasonCode });
      refresh();
    },
    onError: (e) => setMessage({ tone: 'error', text: authErrorMessage(e) }),
  });
  const remove = useSafeMutation({ mutationFn: schedulingApi.removeTimeOff, onSuccess: refresh });
  const submit = async () => {
    if (clashes.length) {
      const ok = await confirm({
        title: `${clashes.length} appointment${clashes.length === 1 ? ' is' : 's are'} booked in this period`,
        description:
          'Time off stops new bookings but does not cancel existing appointments. Add the time off, then cancel the appointments you can’t attend from the schedule (patients are notified and refunded).',
        confirmLabel: 'Add time off anyway',
        tone: 'warning',
      });
      if (!ok) return;
    }
    add.mutate();
  };
  return (
    <Card>
      {dialog}
      <SectionHeader
        icon={CalendarOff}
        title="Time off"
        description="Leave, conferences or clinic closures. Patients can’t book you during time off."
      />
      <form
        className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) submit();
        }}
      >
        <TextField
          label="From"
          type="datetime-local"
          required
          value={form.startsAt}
          onChange={(e) => setForm({ ...form, startsAt: e.target.value })}
        />
        <TextField
          label="Until"
          type="datetime-local"
          required
          value={form.endsAt}
          onChange={(e) => setForm({ ...form, endsAt: e.target.value })}
          error={form.startsAt && form.endsAt && !valid ? 'Must be after the start.' : undefined}
        />
        <SelectField
          label="Reason"
          value={form.reasonCode}
          onChange={(e) => setForm({ ...form, reasonCode: e.target.value })}
          options={TIME_OFF_REASONS.map((r) => ({ value: r, label: TIME_OFF_LABELS[r] ?? r }))}
        />
        <div className="flex items-end">
          <Button
            type="submit"
            variant="secondary"
            className="w-full"
            disabled={!valid}
            loading={add.isPending}
          >
            Add time off
          </Button>
        </div>
      </form>
      {clashes.length > 0 && (
        <Alert tone="warning" className="mt-4" title="Booked in this period">
          <ul className="mt-1 space-y-0.5">
            {clashes.map((a) => (
              <li key={a.id}>
                <Link
                  to={`/app/appointments/${a.id}/consultation`}
                  className="font-medium underline"
                >
                  {formatDateTime(a.startsAt)}
                </Link>{' '}
                · {a.patient?.fullName ?? `Ref ${a.reference}`} · {MODE_LABELS[a.mode]}
              </li>
            ))}
          </ul>
        </Alert>
      )}
      {message && (
        <Alert tone={message.tone} className="mt-4">
          {message.text}
        </Alert>
      )}
      <LoadError queries={[list]} what="your time off" className="mt-3" />
      {list.data?.length === 0 && (
        <p className="mt-4 text-sm text-text-muted">No upcoming time off.</p>
      )}
      <ul className="mt-4 divide-y divide-border">
        {list.data?.map((t) => (
          <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm">
            <span>
              <span className="font-medium text-text">
                {formatDateTime(t.startsAt)} → {formatDateTime(t.endsAt)}
              </span>{' '}
              · {TIME_OFF_LABELS[t.reasonCode] ?? t.reasonCode}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => remove.mutate(t.id)}
              disabled={remove.isPending}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Doctor: weekly consultation hours and time off, with existing bookings in view. */
export function AvailabilityManager() {
  const queryClient = useQueryClient();
  const rules = useQuery({ queryKey: ['availability'], queryFn: schedulingApi.rules });
  const clinics = useQuery({ queryKey: ['doctors', 'clinics'], queryFn: doctorsApi.myClinics });
  const upcoming = useUpcomingAppointments();
  const activeClinics = (clinics.data ?? []).filter((m) => m.status === 'active');
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['availability'] });
  return (
    <div className="space-y-6">
      <Card>
        <SectionHeader
          icon={Clock}
          title="Weekly hours"
          description="When patients in your care team can book you. Removing hours never cancels appointments already booked."
        />
        <div className="mt-4">
          {rules.isPending && <LoadingState label="Loading hours" rows={2} />}
          {rules.isError && <Alert tone="error">{authErrorMessage(rules.error)}</Alert>}
          {rules.data && (
            <WeeklyHours
              rules={rules.data}
              clinics={activeClinics}
              upcoming={upcoming.data}
              onChanged={refresh}
            />
          )}
        </div>
      </Card>
      <Card>
        <SectionHeader
          icon={CalendarPlus}
          title="Add hours"
          description="Choose the type, days and times. Hours that overlap ones you already have are refused, so you can’t be double-booked."
          className="mb-5"
        />
        <RuleForm rules={rules.data ?? []} clinics={activeClinics} onSaved={refresh} />
      </Card>
      <TimeOff upcoming={upcoming.data} />
    </div>
  );
}
