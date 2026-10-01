import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { schedulingApi, doctorsApi } from '../../lib/domainApi.js';
import { authErrorMessage } from '../auth/errorMessages.js';
import { Card } from '../../components/ui/Card.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { Skeleton } from '../../components/ui/Skeleton.jsx';
import {
  MODE_LABELS,
  formatDateTime,
  formatDay,
  formatFee,
  formatTime,
  groupByDay,
  localDate,
} from './format.js';

/**
 * Booking flow: mode → day → slot → reason → confirm. Reached from "My doctors" (the
 * server also requires an active care relationship). `rescheduleId` switches the flow to
 * rescheduling an existing appointment.
 */
export function BookAppointmentPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const doctorId = params.get('doctorId');
  const patientId = params.get('patientId');
  const rescheduleId = params.get('rescheduleId');
  const [mode, setMode] = useState(params.get('mode') ?? 'online');
  const [selected, setSelected] = useState(null);
  const [reason, setReason] = useState('');
  // One idempotency key per booking attempt: retries never create duplicates.
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const doctor = useQuery({
    queryKey: ['doctor', doctorId],
    queryFn: () => doctorsApi.publicProfile(doctorId),
    enabled: Boolean(doctorId),
  });
  const slots = useQuery({
    queryKey: ['slots', doctorId, mode],
    queryFn: () => schedulingApi.slots(doctorId, { from: localDate(0), to: localDate(14), mode }),
    enabled: Boolean(doctorId),
  });
  const days = useMemo(() => groupByDay(slots.data ?? []), [slots.data]);
  const [day, setDay] = useState(null);
  const activeDay = day ?? days[0]?.[0] ?? null;

  const submit = useMutation({
    mutationFn: () =>
      rescheduleId
        ? schedulingApi.reschedule(rescheduleId, selected.startsAt)
        : schedulingApi.book(
            {
              patientId,
              doctorId,
              startsAt: selected.startsAt,
              mode,
              ...(selected.clinicId ? { clinicId: selected.clinicId } : {}),
              reason,
            },
            idempotencyKey,
          ),
    onSuccess: () =>
      navigate('/app/appointments', {
        state: { notice: rescheduleId ? 'Appointment rescheduled.' : 'Appointment booked.' },
      }),
  });

  if (!doctorId || (!patientId && !rescheduleId)) {
    return <Alert tone="error">Choose a doctor from your care team to book.</Alert>;
  }

  return (
    <div className="space-y-6">
      <div>
        <Link to="/app/doctors" className="text-sm font-medium text-primary">
          ← My doctors
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-text">
          {rescheduleId ? 'Reschedule appointment' : 'Book an appointment'}
        </h1>
        {doctor.data && (
          <p className="mt-1 text-text-muted">
            {doctor.data.professionalName} · {doctor.data.primarySpecialization}
          </p>
        )}
      </div>

      {!rescheduleId && (
        <Card>
          <fieldset>
            <legend className="text-sm font-semibold text-text">
              How would you like to consult?
            </legend>
            <div className="mt-3 flex gap-2">
              {Object.entries(MODE_LABELS).map(([value, label]) => (
                <Button
                  key={value}
                  variant={mode === value ? 'primary' : 'secondary'}
                  aria-pressed={mode === value}
                  onClick={() => {
                    setMode(value);
                    setSelected(null);
                    setDay(null);
                  }}
                >
                  {label}
                </Button>
              ))}
            </div>
          </fieldset>
        </Card>
      )}

      <Card>
        <h2 className="text-sm font-semibold text-text">Choose a time</h2>
        {slots.isPending && <Skeleton className="mt-4 h-24 w-full" />}
        {slots.isError && (
          <Alert tone="error" className="mt-4">
            {authErrorMessage(slots.error)}
          </Alert>
        )}
        {slots.data?.length === 0 && (
          <p className="mt-4 text-sm text-text-muted">No available times in the next two weeks.</p>
        )}
        {days.length > 0 && (
          <>
            <div className="mt-4 flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Days">
              {days.map(([key, items]) => (
                <button
                  key={key}
                  role="tab"
                  aria-selected={key === activeDay}
                  onClick={() => {
                    setDay(key);
                    setSelected(null);
                  }}
                  className={`min-h-11 shrink-0 rounded-lg border px-3 text-sm ${key === activeDay ? 'border-primary bg-primary-soft text-primary' : 'border-border text-text-muted'}`}
                >
                  {formatDay(items[0].startsAt).split(',')[0]}{' '}
                  {new Date(items[0].startsAt).getDate()}
                </button>
              ))}
            </div>
            <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-6" role="tabpanel">
              {(days.find(([key]) => key === activeDay)?.[1] ?? []).map((slot) => (
                <button
                  key={slot.startsAt}
                  onClick={() => setSelected(slot)}
                  aria-pressed={selected?.startsAt === slot.startsAt}
                  className={`min-h-11 rounded-lg border text-sm font-medium ${selected?.startsAt === slot.startsAt ? 'border-primary bg-primary text-primary-contrast' : 'border-border text-text hover:bg-surface-muted'}`}
                >
                  {formatTime(slot.startsAt)}
                </button>
              ))}
            </div>
          </>
        )}
      </Card>

      {selected && (
        <Card>
          <h2 className="text-sm font-semibold text-text">Confirm</h2>
          <p className="mt-2 text-sm text-text-muted">
            {formatDateTime(selected.startsAt)} · {MODE_LABELS[selected.mode]} ·{' '}
            {formatFee(selected.feePaise)}
          </p>
          {!rescheduleId && (
            <div className="mt-4">
              <label htmlFor="reason" className="block text-sm font-medium text-text">
                Reason for visit
              </label>
              <p className="text-xs text-text-subtle">Shared only with your doctor.</p>
              <textarea
                id="reason"
                rows={3}
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="mt-1.5 block w-full rounded-lg border border-border bg-surface-raised px-3.5 py-2.5"
              />
            </div>
          )}
          {selected.feePaise > 0 && (
            <Alert tone="info" className="mt-4">
              This time is held for 15 minutes while payment is completed. Online payment arrives in
              an upcoming release.
            </Alert>
          )}
          {submit.isError && (
            <Alert tone="error" className="mt-4">
              {authErrorMessage(submit.error)}
            </Alert>
          )}
          <Button
            className="mt-4"
            onClick={() => submit.mutate()}
            disabled={submit.isPending || (!rescheduleId && reason.trim().length < 3)}
          >
            {submit.isPending ? 'Booking…' : rescheduleId ? 'Confirm new time' : 'Book appointment'}
          </Button>
        </Card>
      )}
    </div>
  );
}
