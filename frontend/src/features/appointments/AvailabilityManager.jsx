import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { TIME_OFF_REASONS } from '@healthbridge/shared';
import { doctorsApi, schedulingApi } from '../../lib/domainApi.js';
import { authErrorMessage } from '../auth/errorMessages.js';
import { Card } from '../../components/ui/Card.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { MODE_LABELS, formatDateTime, formatFee, localDate } from './format.js';

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const inputClass =
  'mt-1.5 block min-h-11 w-full rounded-lg border border-border bg-surface-raised px-3';

function Field({ label, children }) {
  return (
    <label className="block text-sm font-medium text-text">
      {label}
      {children}
    </label>
  );
}

function RuleForm({ onSaved }) {
  const clinics = useQuery({ queryKey: ['doctors', 'clinics'], queryFn: doctorsApi.myClinics });
  const activeClinics = (clinics.data ?? []).filter((m) => m.status === 'active');
  const [form, setForm] = useState({
    mode: 'online',
    clinicId: '',
    weekday: '1',
    startTime: '09:00',
    endTime: '12:00',
    slotMinutes: '15',
    fee: '0',
  });
  const [error, setError] = useState(null);
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });
  const save = useMutation({
    mutationFn: () =>
      schedulingApi.addRule({
        mode: form.mode,
        ...(form.clinicId ? { clinicId: form.clinicId } : {}),
        weekday: Number(form.weekday),
        startTime: form.startTime,
        endTime: form.endTime,
        slotMinutes: Number(form.slotMinutes),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        validFrom: localDate(0),
        feePaise: Math.round(Number(form.fee) * 100),
      }),
    onSuccess: () => {
      setError(null);
      onSaved();
    },
    onError: (e) =>
      setError(e.errors?.length ? e.errors.map((x) => x.message).join(' ') : authErrorMessage(e)),
  });
  return (
    <form
      className="grid gap-4 sm:grid-cols-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Field label="Mode">
        <select className={inputClass} value={form.mode} onChange={set('mode')}>
          {Object.entries(MODE_LABELS).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Clinic">
        <select className={inputClass} value={form.clinicId} onChange={set('clinicId')}>
          <option value="">{form.mode === 'online' ? 'None (online)' : 'Select clinic'}</option>
          {activeClinics.map((m) => (
            <option key={m.clinicId} value={m.clinicId}>
              {m.clinic.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Day">
        <select className={inputClass} value={form.weekday} onChange={set('weekday')}>
          {WEEKDAYS.map((d, i) => (
            <option key={d} value={i + 1}>
              {d}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Slot length (minutes)">
        <input
          type="number"
          min="10"
          max="120"
          step="5"
          className={inputClass}
          value={form.slotMinutes}
          onChange={set('slotMinutes')}
        />
      </Field>
      <Field label="From">
        <input
          type="time"
          className={inputClass}
          value={form.startTime}
          onChange={set('startTime')}
        />
      </Field>
      <Field label="Until">
        <input type="time" className={inputClass} value={form.endTime} onChange={set('endTime')} />
      </Field>
      <Field label="Fee (₹)">
        <input
          type="number"
          min="0"
          step="1"
          className={inputClass}
          value={form.fee}
          onChange={set('fee')}
        />
      </Field>
      <div className="flex items-end">
        <Button type="submit" disabled={save.isPending} className="w-full">
          Add hours
        </Button>
      </div>
      {error && (
        <Alert tone="error" className="sm:col-span-4">
          {error}
        </Alert>
      )}
    </form>
  );
}

function TimeOff() {
  const queryClient = useQueryClient();
  const list = useQuery({ queryKey: ['time-off'], queryFn: schedulingApi.timeOff });
  const [form, setForm] = useState({ startsAt: '', endsAt: '', reasonCode: 'leave' });
  const [message, setMessage] = useState(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['time-off'] });
  const add = useMutation({
    mutationFn: () =>
      schedulingApi.addTimeOff({
        startsAt: new Date(form.startsAt).toISOString(),
        endsAt: new Date(form.endsAt).toISOString(),
        reasonCode: form.reasonCode,
      }),
    onSuccess: (result) => {
      setMessage({
        tone: result.clashingAppointments ? 'info' : 'success',
        text: result.clashingAppointments
          ? `Time off added. ${result.clashingAppointments} existing appointment(s) fall in this period — cancel or keep them from your schedule.`
          : 'Time off added.',
      });
      refresh();
    },
    onError: (e) => setMessage({ tone: 'error', text: authErrorMessage(e) }),
  });
  const remove = useMutation({ mutationFn: schedulingApi.removeTimeOff, onSuccess: refresh });
  return (
    <Card>
      <h2 className="text-base font-semibold text-text">Time off</h2>
      <form
        className="mt-4 grid gap-4 sm:grid-cols-4"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <Field label="From">
          <input
            required
            type="datetime-local"
            className={inputClass}
            value={form.startsAt}
            onChange={(e) => setForm({ ...form, startsAt: e.target.value })}
          />
        </Field>
        <Field label="Until">
          <input
            required
            type="datetime-local"
            className={inputClass}
            value={form.endsAt}
            onChange={(e) => setForm({ ...form, endsAt: e.target.value })}
          />
        </Field>
        <Field label="Reason">
          <select
            className={inputClass}
            value={form.reasonCode}
            onChange={(e) => setForm({ ...form, reasonCode: e.target.value })}
          >
            {TIME_OFF_REASONS.map((r) => (
              <option key={r} value={r}>
                {r.replace('_', ' ')}
              </option>
            ))}
          </select>
        </Field>
        <div className="flex items-end">
          <Button type="submit" variant="secondary" className="w-full" disabled={add.isPending}>
            Add time off
          </Button>
        </div>
      </form>
      {message && (
        <Alert tone={message.tone} className="mt-4">
          {message.text}
        </Alert>
      )}
      <ul className="mt-4 divide-y divide-border">
        {list.data?.map((t) => (
          <li key={t.id} className="flex items-center justify-between gap-3 py-2 text-sm">
            <span>
              {formatDateTime(t.startsAt)} → {formatDateTime(t.endsAt)} ·{' '}
              {t.reasonCode.replace('_', ' ')}
            </span>
            <Button variant="ghost" onClick={() => remove.mutate(t.id)}>
              Remove
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Doctor: weekly consultation hours and time off. */
export function AvailabilityManager() {
  const queryClient = useQueryClient();
  const rules = useQuery({ queryKey: ['availability'], queryFn: schedulingApi.rules });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['availability'] });
  const archive = useMutation({ mutationFn: schedulingApi.archiveRule, onSuccess: refresh });
  return (
    <div className="space-y-6">
      <Card>
        <h2 className="text-base font-semibold text-text">Weekly hours</h2>
        <p className="mt-1 text-sm text-text-muted">
          Patients in your care team can book these times.
        </p>
        {rules.isError && (
          <Alert tone="error" className="mt-4">
            {authErrorMessage(rules.error)}
          </Alert>
        )}
        <ul className="mt-4 divide-y divide-border">
          {rules.data?.map((r) => (
            <li
              key={r.id}
              className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm"
            >
              <span>
                <span className="font-medium text-text">{WEEKDAYS[r.weekday - 1]}</span>{' '}
                {r.startTime}–{r.endTime} · {MODE_LABELS[r.mode]} · {r.slotMinutes} min ·{' '}
                {formatFee(r.feePaise)}
              </span>
              <Button
                variant="ghost"
                onClick={() => archive.mutate(r.id)}
                aria-label={`Remove ${WEEKDAYS[r.weekday - 1]} ${r.startTime}`}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
        <div className="mt-6 border-t border-border pt-6">
          <RuleForm onSaved={refresh} />
        </div>
      </Card>
      <TimeOff />
    </div>
  );
}
