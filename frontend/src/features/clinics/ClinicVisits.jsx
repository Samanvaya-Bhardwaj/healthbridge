import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Building2, CreditCard, ShieldOff, UserCheck, Video } from 'lucide-react';
import { paymentsApi, schedulingApi } from '../../lib/domainApi.js';
import { authErrorMessage } from '../auth/errorMessages.js';
import { Alert } from '../../components/ui/Alert.jsx';
import { Badge, StatusBadge } from '../../components/ui/Badge.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { Dialog } from '../../components/ui/Dialog.jsx';
import { RadioGroup, TextField } from '../../components/ui/Fields.jsx';
import { useConfirm } from '../../components/ui/useConfirm.jsx';
import { MODE_LABELS, formatDateTime, formatFee, formatTime } from '../appointments/format.js';
import { paymentText, refundable, usePaymentState } from './clinicWork.js';
import { useSafeMutation } from '../../lib/useSafeMutation.js';

/** The role boundary, stated where clinic administrators work. */
export function OperationsBoundary({ compact = false }) {
  return (
    <div
      className={`flex items-start gap-3 rounded-xl border border-border bg-surface-muted ${
        compact ? 'px-3 py-2 text-xs' : 'px-4 py-3 text-sm'
      } text-text-muted`}
    >
      <ShieldOff aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-text-subtle" />
      <p>
        <span className="font-medium text-text">Clinic operations only.</span> You manage schedules,
        check-ins, payments and the clinic team. Patient names, visit reasons, notes, prescriptions
        and medical records stay with patients and their doctors; patients identify themselves at
        the desk with their booking reference.
      </p>
    </div>
  );
}

const REASONS = [
  {
    value: 'goodwill',
    label: 'Goodwill gesture',
    description: 'For example, a long wait or a visit cut short.',
  },
  {
    value: 'duplicate_payment',
    label: 'Charged twice',
    description: 'The patient paid more than once for the same visit.',
  },
  { value: 'other', label: 'Other reason', description: 'Recorded as “other”.' },
];

/** Money back to the patient for one paid appointment, explained before it is sent. */
export function RefundDialog({ a, paymentState, onClose }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('goodwill');
  const [part, setPart] = useState('rest');
  const [amount, setAmount] = useState('');
  // One key per dialog: a retried click can never refund twice.
  const [key] = useState(() => crypto.randomUUID());
  const partly = paymentState === 'partially_refunded';
  const paise = part === 'amount' ? Math.round(Number(amount || 0) * 100) : undefined;
  const invalid = part === 'amount' && (!paise || paise <= 0 || paise > a.feePaise);
  const refund = useSafeMutation({
    mutationFn: () =>
      paymentsApi.refund(
        a.id,
        { reasonCode: reason, ...(paise ? { amountPaise: paise } : {}) },
        key,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['appointment', a.id] });
    },
  });
  const done = refund.data;
  return (
    <Dialog
      open
      title={done ? 'Refund requested' : `Refund Ref ${a.reference}?`}
      description={
        done
          ? undefined
          : `${formatDateTime(a.startsAt)} with ${a.doctor?.professionalName ?? 'the doctor'} · ${MODE_LABELS[a.mode]}`
      }
      onClose={onClose}
      footer={
        done ? (
          <Button onClick={onClose} data-autofocus>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Keep payment
            </Button>
            <Button
              icon={CreditCard}
              onClick={() => refund.mutate()}
              disabled={invalid}
              loading={refund.isPending}
            >
              {part === 'amount' && paise ? `Refund ${formatFee(paise)}` : 'Refund the rest'}
            </Button>
          </>
        )
      }
    >
      {done ? (
        <p className="text-sm text-text">
          {formatFee(done.amountPaise)} will go back to the patient’s original payment method. The
          payment shows as refunded once the payment provider confirms it.
        </p>
      ) : (
        <div className="space-y-5">
          <dl className="grid grid-cols-2 gap-3 rounded-lg bg-surface-muted p-3 text-sm">
            <div>
              <dt className="text-text-muted">Patient paid</dt>
              <dd className="font-medium text-text">{formatFee(a.feePaise)}</dd>
            </div>
            <div>
              <dt className="text-text-muted">Now</dt>
              <dd className="font-medium text-text">{paymentText(a, paymentState)}</dd>
            </div>
          </dl>
          <RadioGroup
            legend="Why are you refunding?"
            name={`reason-${a.id}`}
            value={reason}
            onChange={setReason}
            options={REASONS}
          />
          <RadioGroup
            legend="How much?"
            name={`part-${a.id}`}
            value={part}
            onChange={setPart}
            options={[
              {
                value: 'rest',
                label: partly
                  ? 'Everything not yet refunded'
                  : `All of it (${formatFee(a.feePaise)})`,
              },
              { value: 'amount', label: 'A specific amount' },
            ]}
          />
          {part === 'amount' && (
            <TextField
              label="Amount (₹)"
              type="number"
              min="1"
              step="1"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              error={
                amount && invalid ? `Enter an amount up to ${formatFee(a.feePaise)}.` : undefined
              }
              hint={partly ? 'It can’t exceed what is still unrefunded.' : undefined}
            />
          )}
          <p className="text-xs text-text-subtle">
            Refunds can’t be undone. The patient is notified, and the refund is recorded with your
            name and the reason.
          </p>
          {refund.isError && <Alert tone="error">{authErrorMessage(refund.error)}</Alert>}
        </div>
      )}
    </Dialog>
  );
}

/** One appointment on the clinic board: operational facts and actions only. */
export function ClinicVisitRow({ a, now }) {
  const queryClient = useQueryClient();
  const payment = usePaymentState(a);
  const [refunding, setRefunding] = useState(false);
  const { confirm, dialog } = useConfirm();
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['clinic-board'] });
    queryClient.invalidateQueries({ queryKey: ['appointment', a.id] });
  };
  const act = useSafeMutation({
    mutationFn: (action) =>
      action === 'cancel'
        ? schedulingApi.cancel(a.id, 'clinic_closed')
        : schedulingApi.action(a.id, action),
    onSuccess: refresh,
  });
  const late =
    a.mode === 'in_clinic' &&
    a.status === 'confirmed' &&
    now > new Date(a.startsAt).getTime() + 15 * 60_000;
  // The server accepts check-in from one hour before the start until the visit ends.
  const ended = Boolean(a.endsAt) && now >= new Date(a.endsAt).getTime();
  const canCheckIn =
    a.mode === 'in_clinic' &&
    a.status === 'confirmed' &&
    !ended &&
    now >= new Date(a.startsAt).getTime() - 60 * 60_000;
  const cancelVisit = async () => {
    const ok = await confirm({
      title: `Cancel Ref ${a.reference}?`,
      description: `${formatDateTime(a.startsAt)} with ${a.doctor?.professionalName ?? 'the doctor'}. The patient is notified${
        a.feePaise ? ' and their payment is refunded in full automatically' : ''
      }. This can’t be undone.`,
      confirmLabel: 'Cancel appointment',
      cancelLabel: 'Keep it',
      destructive: true,
      tone: 'warning',
    });
    if (ok) act.mutate('cancel');
  };
  const checkInText =
    a.mode === 'online'
      ? 'Online: no check-in'
      : a.checkedInAt
        ? `Checked in ${formatTime(a.checkedInAt)}`
        : a.status === 'confirmed'
          ? ended
            ? 'Ended without check-in'
            : late
              ? 'Not arrived (late)'
              : 'Not arrived yet'
          : null;
  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3">
      {dialog}
      <div className="w-20 shrink-0">
        <p className="whitespace-nowrap font-semibold tabular-nums text-text">
          {formatTime(a.startsAt)}
        </p>
        {a.endsAt && <p className="text-xs text-text-subtle">{formatTime(a.endsAt)}</p>}
      </div>
      <div className="min-w-0 flex-1">
        <p className="font-medium text-text">{a.doctor?.professionalName ?? 'Doctor'}</p>
        <p className="flex flex-wrap items-center gap-x-2 text-sm text-text-muted">
          <span className="font-mono text-text">Ref {a.reference}</span>
          <span className="flex items-center gap-1">
            {a.mode === 'online' ? (
              <Video aria-hidden="true" className="h-3.5 w-3.5" />
            ) : (
              <Building2 aria-hidden="true" className="h-3.5 w-3.5" />
            )}
            {MODE_LABELS[a.mode]}
          </span>
        </p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <StatusBadge status={a.status} />
          {checkInText && (
            <Badge tone={late ? 'warning' : a.checkedInAt ? 'success' : 'neutral'}>
              {checkInText}
            </Badge>
          )}
          <Badge
            tone={
              payment.data === 'paid'
                ? 'success'
                : ['refunded', 'partially_refunded'].includes(payment.data)
                  ? 'info'
                  : a.status === 'pending_payment'
                    ? 'warning'
                    : 'neutral'
            }
          >
            {paymentText(a, payment.data)}
          </Badge>
        </div>
        {act.isError && (
          <Alert tone="error" className="mt-2">
            {authErrorMessage(act.error)}
          </Alert>
        )}
      </div>
      <div className="flex w-full flex-wrap gap-2 sm:pl-24">
        {canCheckIn && (
          <Button
            size="sm"
            icon={UserCheck}
            onClick={() => act.mutate('check-in')}
            loading={act.isPending && act.variables === 'check-in'}
          >
            Check in
          </Button>
        )}
        {refundable(payment.data) && (
          <Button
            size="sm"
            variant="secondary"
            icon={CreditCard}
            onClick={() => setRefunding(true)}
          >
            Refund
          </Button>
        )}
        {['confirmed', 'pending_payment'].includes(a.status) &&
          now < new Date(a.startsAt).getTime() && (
            <Button size="sm" variant="ghost" onClick={cancelVisit} disabled={act.isPending}>
              Cancel
            </Button>
          )}
      </div>
      {refunding && (
        <RefundDialog a={a} paymentState={payment.data} onClose={() => setRefunding(false)} />
      )}
    </li>
  );
}
