import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { paymentsApi, schedulingApi } from '../../lib/domainApi.js';
import { authErrorMessage } from '../auth/errorMessages.js';
import { Card } from '../../components/ui/Card.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { Skeleton } from '../../components/ui/Skeleton.jsx';
import { MODE_LABELS, formatDateTime, formatFee, formatTime } from './format.js';
import { openRazorpayCheckout } from './razorpayCheckout.js';

const POLL_MS = 2_000;
const SLOW_AFTER_MS = 60_000;

/**
 * Payment for a PENDING_PAYMENT booking. The amount shown and charged comes from the
 * server. After the checkout the page polls the appointment: only the server (on the
 * provider's verified webhook) can confirm it — the browser never marks anything paid.
 */
export function PaymentPage() {
  const { id } = useParams();
  const queryClient = useQueryClient();
  // review → checkout (test-mode panel) → processing
  const [phase, setPhase] = useState('review');
  const [checkout, setCheckout] = useState(null);
  const [processingSince, setProcessingSince] = useState(null);
  const [launchError, setLaunchError] = useState(null);

  const appointment = useQuery({
    queryKey: ['appointment', id],
    queryFn: () => schedulingApi.get(id),
    refetchInterval: (query) => {
      const a = query.state.data;
      const settled = a && (a.status !== 'pending_payment' || a.paymentStatus === 'failed');
      return phase === 'processing' && !settled ? POLL_MS : false;
    },
  });

  const toProcessing = () => {
    setProcessingSince(Date.now());
    setPhase('processing');
    queryClient.invalidateQueries({ queryKey: ['appointment', id] });
  };

  const start = useMutation({
    mutationFn: () => paymentsApi.checkout(id),
    onSuccess: async (result) => {
      setCheckout(result);
      setLaunchError(null);
      if (result.checkout.provider === 'razorpay') {
        try {
          await openRazorpayCheckout(result.checkout, {
            onSubmitted: toProcessing,
            onDismiss: () => setPhase('review'),
          });
        } catch (err) {
          setLaunchError(err.message);
        }
      } else {
        setPhase('checkout');
      }
    },
  });
  const simulate = useMutation({
    mutationFn: (outcome) => paymentsApi.simulate(id, outcome),
    onSuccess: toProcessing,
  });

  const a = appointment.data;
  if (appointment.isPending) return <Skeleton className="h-48 w-full" />;
  if (appointment.isError) return <Alert tone="error">{authErrorMessage(appointment.error)}</Alert>;

  const back = (
    <Link to="/app/appointments" className="text-sm font-medium text-primary">
      ← Appointments
    </Link>
  );
  const summary = (
    <dl className="grid gap-2 text-sm sm:grid-cols-2">
      <div>
        <dt className="text-text-muted">Doctor</dt>
        <dd className="font-medium text-text">{a.doctor?.professionalName}</dd>
      </div>
      <div>
        <dt className="text-text-muted">When</dt>
        <dd className="font-medium text-text">{formatDateTime(a.startsAt)}</dd>
      </div>
      <div>
        <dt className="text-text-muted">Consultation</dt>
        <dd className="font-medium text-text">
          {MODE_LABELS[a.mode]}
          {a.clinic && ` · ${a.clinic.name}`}
        </dd>
      </div>
      <div>
        <dt className="text-text-muted">Booking reference</dt>
        <dd className="font-medium text-text">{a.reference}</dd>
      </div>
    </dl>
  );

  if (a.status === 'confirmed' || a.status === 'checked_in') {
    return (
      <div className="space-y-6">
        {back}
        <Alert tone="success">
          {a.paymentStatus === 'paid' ? 'Payment received — ' : ''}your appointment is confirmed.
        </Alert>
        <Card>{summary}</Card>
      </div>
    );
  }
  if (a.status !== 'pending_payment') {
    return (
      <div className="space-y-6">
        {back}
        <Alert tone="error">
          {a.status === 'expired'
            ? 'The time to pay for this booking ran out and the slot was released. Please book again.'
            : 'This appointment can no longer be paid for.'}
        </Alert>
        <Card>{summary}</Card>
      </div>
    );
  }

  const failed = a.paymentStatus === 'failed';
  const slow =
    phase === 'processing' &&
    processingSince !== null &&
    appointment.dataUpdatedAt - processingSince > SLOW_AFTER_MS;

  return (
    <div className="space-y-6">
      {back}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-text">Complete payment</h1>
        <p className="mt-1 text-text-muted">
          Your slot is reserved until {formatTime(a.holdExpiresAt)}. It is confirmed as soon as the
          payment is received.
        </p>
      </div>

      <Card>
        {summary}
        <div className="mt-4 flex items-baseline justify-between border-t border-border pt-4">
          <span className="text-sm text-text-muted">Consultation fee</span>
          <span className="text-xl font-semibold text-text">{formatFee(a.feePaise)}</span>
        </div>
      </Card>

      {start.isError && <Alert tone="error">{authErrorMessage(start.error)}</Alert>}
      {simulate.isError && <Alert tone="error">{authErrorMessage(simulate.error)}</Alert>}
      {launchError && <Alert tone="error">{launchError}</Alert>}

      {phase === 'processing' && !failed && (
        <Card>
          <p role="status" className="font-medium text-text">
            Confirming your payment…
          </p>
          <p className="mt-1 text-sm text-text-muted">
            {slow
              ? 'This is taking longer than usual. You can leave this page — we will email you as soon as the payment is confirmed.'
              : 'Waiting for confirmation from the payment provider. Please keep this page open.'}
          </p>
        </Card>
      )}

      {failed && phase !== 'checkout' && (
        <Alert tone="error">
          The payment did not go through and no money was taken for that attempt. You can try again
          while your slot is reserved.
        </Alert>
      )}

      {phase === 'checkout' && checkout?.checkout.provider === 'fake' && (
        <Card>
          <h2 className="text-sm font-semibold text-text">Test payment</h2>
          <p className="mt-1 text-sm text-text-muted">
            Demo environment: no real money moves. Choose an outcome — the server receives a signed
            test webhook exactly as it would from a real payment provider.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button onClick={() => simulate.mutate('success')} disabled={simulate.isPending}>
              Simulate successful payment
            </Button>
            <Button
              variant="secondary"
              onClick={() => simulate.mutate('failure')}
              disabled={simulate.isPending}
            >
              Simulate failed payment
            </Button>
          </div>
        </Card>
      )}

      {(phase === 'review' || (failed && phase === 'processing')) && (
        <Button
          onClick={() => {
            setPhase('review');
            start.mutate();
          }}
          disabled={start.isPending}
        >
          {failed ? 'Try again' : `Pay ${formatFee(a.feePaise)}`}
        </Button>
      )}
    </div>
  );
}
