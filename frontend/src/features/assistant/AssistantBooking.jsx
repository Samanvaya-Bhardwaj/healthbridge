import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarCheck2, CheckCircle2, CreditCard, Hourglass } from 'lucide-react';
import { assistantApi, paymentsApi, schedulingApi } from '../../lib/domainApi.js';
import { authErrorMessage } from '../auth/errorMessages.js';
import { Alert } from '../../components/ui/Alert.jsx';
import { Badge } from '../../components/ui/Badge.jsx';
import { Button, ButtonLink } from '../../components/ui/Button.jsx';
import { TextAreaField } from '../../components/ui/Fields.jsx';
import { useSafeMutation } from '../../lib/useSafeMutation.js';
import { MODE_LABELS, formatDateTime, formatFee } from '../appointments/format.js';
import { openRazorpayCheckout } from '../appointments/razorpayCheckout.js';
import { CalendarLinks } from '../appointments/CalendarLinks.jsx';

const POLL_MS = 2_000;

/**
 * ADR-0038: a booking the assistant proposed. Nothing is booked until the person taps
 * Confirm booking; the backend then books through the one booking path (and joins the
 * care team first when needed). Paid times are paid here, in the conversation.
 */
export function BookingCard({ card, sessionId, actingFor, latest, onAskAgain }) {
  const [reason, setReason] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const confirm = useSafeMutation({
    mutationFn: () => assistantApi.confirm(sessionId, card.actionId, { reason: reason.trim() }),
    onSuccess: (res) => {
      setError(null);
      setResult(res);
    },
    onError: (err) => setError(err),
  });
  const whose = actingFor === 'dependent' ? 'their' : 'your';
  const fee = card.feePaise > 0 ? formatFee(card.feePaise) : 'Free';
  if (result) return <BookingOutcome result={result} card={card} />;
  const gone = [
    'assistant_action_expired',
    'assistant_action_closed',
    'slot_unavailable',
    'slot_not_offered',
  ].includes(error?.code);
  return (
    <section
      aria-label="Booking to confirm"
      className="mt-3 rounded-xl border border-primary/30 bg-surface p-4"
    >
      <p className="mb-2 flex flex-wrap items-center gap-2 text-sm font-semibold text-text">
        <CalendarCheck2 aria-hidden="true" className="h-4 w-4 text-primary" />
        Check and confirm
        <Badge tone="warning">Not booked yet</Badge>
      </p>
      <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-text-muted">Doctor</dt>
          <dd className="font-medium text-text">
            {card.doctor.professionalName}
            {card.doctor.primarySpecialization && (
              <span className="block text-xs font-normal text-text-muted">
                {card.doctor.primarySpecialization}
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-text-muted">When</dt>
          <dd className="font-medium text-text">{formatDateTime(card.startsAt)}</dd>
        </div>
        <div>
          <dt className="text-text-muted">Consultation</dt>
          <dd className="font-medium text-text">
            {MODE_LABELS[card.mode]}
            {card.clinic &&
              ` · ${card.clinic.name}${card.clinic.city ? `, ${card.clinic.city}` : ''}`}
          </dd>
        </div>
        <div>
          <dt className="text-text-muted">Fee</dt>
          <dd className="font-medium text-text">
            {fee}
            {card.feePaise > 0 && (
              <span className="block text-xs font-normal text-text-muted">
                Paid next, here; the time is held while you pay.
              </span>
            )}
          </dd>
        </div>
      </dl>
      {card.joinsCareTeam && (
        <p className="mt-3 text-sm text-text-muted">
          {card.acceptsNewPatients
            ? `Confirming also adds ${card.doctor.professionalName} to ${whose} care team (they accept new patients).`
            : `${card.doctor.professionalName} accepts new patients personally: confirming sends a care request, and you can book once they accept.`}
        </p>
      )}
      <div className="mt-3">
        <TextAreaField
          label="Reason for the visit"
          hint="Shared with the doctor, as on the booking page."
          value={reason}
          rows={2}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
          disabled={!latest || confirm.isPending}
        />
      </div>
      {error && (
        <Alert tone="error" className="mt-3">
          {authErrorMessage(error)}
          {gone && (
            <Button size="sm" variant="secondary" className="mt-2" onClick={onAskAgain}>
              Show other times
            </Button>
          )}
        </Alert>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button
          type="button"
          onClick={() => confirm.mutate()}
          loading={confirm.isPending}
          disabled={!latest || reason.trim().length < 3}
        >
          Confirm booking
        </Button>
        <p className="text-xs text-text-muted">
          {latest
            ? 'Nothing is booked until you confirm. You can cancel later from Appointments.'
            : 'A newer suggestion replaced this one.'}
        </p>
      </div>
    </section>
  );
}

/** After Confirm: waiting for the doctor, or the appointment (paid here when needed). */
function BookingOutcome({ result, card }) {
  if (result.status === 'awaiting_doctor') {
    return (
      <Alert tone="info" className="mt-3" title="Care request sent">
        {card.doctor.professionalName} accepts new patients personally. You’ll get a notification
        when they accept; then ask me again and I’ll book the time.
      </Alert>
    );
  }
  return <AppointmentInChat appointmentId={result.appointmentId} />;
}

function AppointmentInChat({ appointmentId }) {
  const queryClient = useQueryClient();
  const [paying, setPaying] = useState(false);
  const appointment = useQuery({
    queryKey: ['appointment', appointmentId],
    queryFn: () => schedulingApi.get(appointmentId),
    refetchInterval: (q) => {
      const a = q.state.data;
      return paying && a?.status === 'pending_payment' && a.paymentStatus !== 'failed'
        ? POLL_MS
        : false;
    },
  });
  const a = appointment.data;
  if (appointment.isPending) return <p className="mt-3 text-sm text-text-muted">Booking…</p>;
  if (appointment.isError) {
    return (
      <Alert tone="error" className="mt-3">
        {authErrorMessage(appointment.error)}
      </Alert>
    );
  }
  if (a.status === 'pending_payment') {
    return (
      <PayInChat
        appointment={a}
        onSubmitted={() => {
          setPaying(true);
          queryClient.invalidateQueries({ queryKey: ['appointment', appointmentId] });
        }}
        processing={paying && a.paymentStatus !== 'failed'}
        failed={a.paymentStatus === 'failed'}
      />
    );
  }
  if (['confirmed', 'checked_in'].includes(a.status)) {
    return (
      <section
        aria-label="Booked"
        className="mt-3 rounded-xl border border-success/30 bg-success/5 p-4"
      >
        <p className="flex items-center gap-2 text-sm font-semibold text-text">
          <CheckCircle2 aria-hidden="true" className="h-4 w-4 text-success" />
          Booked{a.paymentStatus === 'paid' ? ' and paid' : ''}: {formatDateTime(a.startsAt)} with{' '}
          {a.doctor?.professionalName}
        </p>
        <p className="mt-1 text-sm text-text-muted">
          Reference {a.reference}. A confirmation with a calendar invitation is on its way to your
          email, and it’s in your notifications.
        </p>
        <div className="mt-3">
          <CalendarLinks appointment={a} compact />
        </div>
        <ButtonLink
          as={Link}
          to={`/app/appointments/${a.id}`}
          size="sm"
          variant="secondary"
          className="mt-3"
        >
          Open the appointment
        </ButtonLink>
      </section>
    );
  }
  return (
    <Alert tone="warning" className="mt-3">
      This booking is {a.status.replace('_', ' ')}. Open Appointments for details.
    </Alert>
  );
}

/**
 * Pays a held booking in the conversation. Like the payment page, the browser never marks
 * anything paid: the server confirms after the provider's verified webhook.
 */
function PayInChat({ appointment: a, onSubmitted, processing, failed }) {
  const [checkout, setCheckout] = useState(null);
  const [launchError, setLaunchError] = useState(null);
  const start = useSafeMutation({
    mutationFn: () => paymentsApi.checkout(a.id),
    onSuccess: async (res) => {
      setLaunchError(null);
      if (res.checkout.provider === 'razorpay') {
        try {
          await openRazorpayCheckout(res.checkout, { onSubmitted, onDismiss: () => {} });
        } catch (err) {
          setLaunchError(err.message);
        }
      } else {
        setCheckout(res);
      }
    },
  });
  const simulate = useSafeMutation({
    mutationFn: (outcome) => paymentsApi.simulate(a.id, outcome),
    onSuccess: onSubmitted,
  });
  return (
    <section
      aria-label="Payment"
      className="mt-3 rounded-xl border border-warning/40 bg-warning/5 p-4"
    >
      <p className="flex items-center gap-2 text-sm font-semibold text-text">
        <CreditCard aria-hidden="true" className="h-4 w-4" />
        Pay {formatFee(a.feePaise)} to confirm {formatDateTime(a.startsAt)}
      </p>
      {a.holdExpiresAt && (
        <p className="mt-1 text-xs text-text-muted">
          <Hourglass aria-hidden="true" className="mr-1 inline h-3 w-3" />
          The time is held until {formatDateTime(a.holdExpiresAt)}.
        </p>
      )}
      {failed && (
        <Alert tone="error" className="mt-3">
          The payment didn’t go through and no money was taken. You can try again.
        </Alert>
      )}
      {(start.isError || simulate.isError || launchError) && (
        <Alert tone="error" className="mt-3">
          {launchError ?? authErrorMessage(start.error ?? simulate.error)}
        </Alert>
      )}
      {processing ? (
        <p className="mt-3 text-sm text-text-muted" role="status">
          Waiting for the payment provider to confirm…
        </p>
      ) : checkout ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button onClick={() => simulate.mutate('success')} loading={simulate.isPending}>
            Pay {formatFee(a.feePaise)} (test payment)
          </Button>
          <Button variant="ghost" onClick={() => simulate.mutate('failure')}>
            Simulate a failed payment
          </Button>
          <p className="w-full text-xs text-text-muted">
            Test mode: no real money moves. A live deployment opens the payment window instead.
          </p>
        </div>
      ) : (
        <Button className="mt-3" onClick={() => start.mutate()} loading={start.isPending}>
          Pay {formatFee(a.feePaise)}
        </Button>
      )}
    </section>
  );
}
