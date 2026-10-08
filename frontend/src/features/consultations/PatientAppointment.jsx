import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { APPOINTMENT_CONSENT_GRACE_HOURS, PATIENT_FULL_REFUND_HOURS } from '@healthbridge/shared';
import {
  Building2,
  CalendarClock,
  CalendarPlus,
  CheckCircle2,
  Clock,
  CreditCard,
  FileText,
  HeartPulse,
  Lock,
  Pill,
  ShieldCheck,
  Stethoscope,
  Upload,
  Video,
  XCircle,
} from 'lucide-react';
import { consentsApi, followUpApi, recordsApi, schedulingApi } from '../../lib/domainApi.js';
import { authErrorMessage } from '../auth/errorMessages.js';
import { Alert } from '../../components/ui/Alert.jsx';
import { StatusBadge } from '../../components/ui/Badge.jsx';
import { Button, ButtonLink } from '../../components/ui/Button.jsx';
import { Card } from '../../components/ui/Card.jsx';
import { PersonIdentity } from '../../components/ui/Identity.jsx';
import { PageHeader, SectionHeader } from '../../components/ui/Typography.jsx';
import { useConfirm } from '../../components/ui/useConfirm.jsx';
import {
  MODE_LABELS,
  formatDateOnly,
  formatDateTime,
  formatDay,
  formatFee,
  formatTime,
} from '../appointments/format.js';
import { SCOPE_LABELS } from '../records/labels.js';
import { EmergencyGuidance, NoteView, VideoPanel } from './ConsultationParts.jsx';
import { PrescriptionList } from './Prescriptions.jsx';
import { LoadError } from '../../components/ui/LoadError.jsx';
import { useSafeMutation } from '../../lib/useSafeMutation.js';

const UPCOMING = ['pending_payment', 'confirmed', 'checked_in'];
const SHARE_SCOPES = ['patient_profile', 'medical_documents'];

/** One prominent panel: what is happening now and the single next action. */
function NextStep({ tone = 'primary', icon: Icon, title, children, action }) {
  const tones = {
    primary: 'border-primary/30 bg-primary-soft',
    warning: 'border-warning/40 bg-warning/10',
    success: 'border-success/40 bg-success/10',
    neutral: 'border-border bg-surface-muted',
  };
  return (
    <section
      aria-label="What happens next"
      className={`rounded-2xl border p-5 sm:p-6 ${tones[tone]}`}
    >
      <div className="flex gap-4">
        <span
          aria-hidden="true"
          className="hidden h-11 w-11 shrink-0 items-center justify-center rounded-full bg-surface-raised text-primary sm:flex"
        >
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold text-text">{title}</h2>
          <div className="mt-1 space-y-2 text-sm leading-relaxed text-text">{children}</div>
          {action && <div className="mt-4 flex flex-wrap gap-2">{action}</div>}
        </div>
      </div>
    </section>
  );
}

function bookAgainLink(a) {
  return `/app/appointments/book?doctorId=${a.doctorId}&patientId=${a.patientId}`;
}

function NowPanel({ a, view, status, appointmentId }) {
  const c = view.consultation;
  const waiting = status?.waitingRoom ?? view.waitingRoom;
  const doctor = a.doctorName;

  if (c?.status === 'live') {
    return c.video ? (
      <NextStep icon={Video} title="Your consultation has started">
        <p>{doctor} is ready. Join the video call below; allow camera and microphone access.</p>
        <VideoPanel appointmentId={appointmentId} />
      </NextStep>
    ) : (
      <NextStep icon={Stethoscope} title="Your consultation is in progress at the clinic" />
    );
  }
  if (c?.outcome === 'online_managed') {
    return (
      <NextStep tone="success" icon={CheckCircle2} title="Consultation complete">
        <p>
          {doctor} managed this consultation online. The summary and any prescription are below.
        </p>
        {c.outcomeDetail?.followUpOn && (
          <p>Your doctor suggested a follow-up on {formatDateOnly(c.outcomeDetail.followUpOn)}.</p>
        )}
      </NextStep>
    );
  }
  if (c?.outcome === 'physical_visit_required') {
    return (
      <NextStep
        tone="warning"
        icon={Building2}
        title="Your doctor would like to see you in person"
        action={
          <ButtonLink as={Link} icon={Building2} to={`${bookAgainLink(a)}&mode=in_clinic`}>
            Book an in-clinic visit
          </ButtonLink>
        }
      >
        {c.outcomeDetail?.visitNote && <p>{c.outcomeDetail.visitNote}</p>}
        <p>Book a visit at the clinic so {doctor} can examine you.</p>
      </NextStep>
    );
  }
  if (c?.outcome === 'emergency_escalation') return null; // fixed guidance shown above
  if (c?.status === 'ended') {
    return <NextStep tone="neutral" icon={CheckCircle2} title="Consultation finished" />;
  }

  switch (a.status) {
    case 'pending_payment':
      return (
        <NextStep
          tone="warning"
          icon={CreditCard}
          title="Payment needed to confirm"
          action={
            <ButtonLink as={Link} to={`/app/appointments/${a.id}/pay`} icon={CreditCard}>
              Pay {formatFee(a.feePaise)}
            </ButtonLink>
          }
        >
          <p>
            Your time is held
            {a.holdExpiresAt ? ` until ${formatTime(a.holdExpiresAt)}` : ' for a short time'}. If it
            isn’t paid by then, the time is released.
          </p>
        </NextStep>
      );
    case 'confirmed':
      if (a.mode === 'online') {
        return waiting?.open ? (
          <NextStep icon={Clock} title="You’re in the waiting room">
            <p>
              Keep this page open. {doctor} will start the consultation shortly, and the video call
              will appear here. {doctor} can see that you are waiting.
            </p>
          </NextStep>
        ) : (
          <NextStep icon={CalendarClock} title="You’re booked">
            <p>
              Come back to this page at {formatTime(waiting?.opensAt ?? a.startsAt)} on{' '}
              {formatDay(a.startsAt)}: the waiting room opens 15 minutes before the start, and you
              join the video call from here.
            </p>
            <p>Meanwhile, use the checklist below to prepare.</p>
          </NextStep>
        );
      }
      return (
        <NextStep icon={Building2} title="You’re booked for a clinic visit">
          <p>
            Go to {a.clinicName ?? 'the clinic'} on {formatDay(a.startsAt)} at{' '}
            {formatTime(a.startsAt)}. Check in at reception (from one hour before the start).
          </p>
          {a.clinicAddress && <p className="font-medium text-text">{a.clinicAddress}</p>}
        </NextStep>
      );
    case 'checked_in':
      return (
        <NextStep icon={CheckCircle2} title="You’re checked in">
          <p>Please wait to be called. {doctor} will see you shortly.</p>
        </NextStep>
      );
    case 'in_consultation':
      return <NextStep icon={Stethoscope} title="Your consultation is in progress" />;
    case 'completed':
      return (
        <NextStep tone="success" icon={CheckCircle2} title="Consultation complete">
          <p>The summary and any prescription appear below once your doctor signs them.</p>
        </NextStep>
      );
    case 'cancelled':
      return (
        <NextStep
          tone="neutral"
          icon={XCircle}
          title="This appointment was cancelled"
          action={
            <ButtonLink as={Link} to={bookAgainLink(a)} variant="secondary" icon={CalendarPlus}>
              Book another time
            </ButtonLink>
          }
        >
          <p>
            {a.cancelledByParty === 'patient'
              ? 'You cancelled it'
              : a.cancelledByParty
                ? 'It was cancelled by the doctor or clinic'
                : 'It was cancelled'}
            {a.cancelledAt ? ` on ${formatDateTime(a.cancelledAt)}` : ''}.
            {a.paymentStatus === 'refunded' && ' Your payment has been refunded.'}
            {a.paymentStatus === 'partially_refunded' && ' Part of your payment was refunded.'}
          </p>
        </NextStep>
      );
    case 'expired':
      return (
        <NextStep
          tone="neutral"
          icon={Clock}
          title="This booking was released"
          action={
            <ButtonLink as={Link} to={bookAgainLink(a)} variant="secondary" icon={CalendarPlus}>
              Book another time
            </ButtonLink>
          }
        >
          <p>The payment wasn’t completed in time, so the time was freed for others.</p>
        </NextStep>
      );
    case 'no_show':
      return (
        <NextStep
          tone="neutral"
          icon={XCircle}
          title="This appointment was missed"
          action={
            <ButtonLink as={Link} to={bookAgainLink(a)} variant="secondary" icon={CalendarPlus}>
              Book another time
            </ButtonLink>
          }
        >
          <p>It was marked as missed. If you still need care, book another time.</p>
        </NextStep>
      );
    default:
      return null;
  }
}

function Details({ a }) {
  const rows = [
    ['When', `${formatDay(a.startsAt)}, ${formatTime(a.startsAt)}–${formatTime(a.endsAt)}`],
    ['Type', MODE_LABELS[a.mode]],
    ...(a.clinicName
      ? [
          [
            'Where',
            <>
              {a.clinicName}
              {a.clinicAddress && <span className="block text-text-muted">{a.clinicAddress}</span>}
              {a.clinicPhone && (
                <a href={`tel:${a.clinicPhone}`} className="block text-primary hover:underline">
                  {a.clinicPhone}
                </a>
              )}
            </>,
          ],
        ]
      : []),
    ...(a.feePaise !== undefined ? [['Fee', formatFee(a.feePaise)]] : []),
    ...(a.reference ? [['Reference', a.reference]] : []),
  ];
  return (
    <Card>
      <SectionHeader icon={CalendarClock} title="Visit details" />
      <div className="mt-4">
        <PersonIdentity name={a.doctorName} verified detail={a.doctorSpecialization} />
      </div>
      <dl className="mt-4 divide-y divide-border text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-3 py-2">
            <dt className="text-text-muted">{label}</dt>
            <dd className="text-right font-medium text-text">{value}</dd>
          </div>
        ))}
        {a.paymentStatus && (
          <div className="flex items-center justify-between gap-3 py-2">
            <dt className="text-text-muted">Payment</dt>
            <dd>
              <StatusBadge status={a.paymentStatus} />
            </dd>
          </div>
        )}
      </dl>
      {a.reason && (
        <div className="mt-3 rounded-lg bg-surface-muted p-3 text-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-text-subtle">
            Your reason for visit
          </p>
          <p className="mt-1 whitespace-pre-wrap text-text">{a.reason}</p>
        </div>
      )}
    </Card>
  );
}

/** Consent for this appointment: who, what, why, how long, how to revoke. */
function SharingItem({ a }) {
  const queryClient = useQueryClient();
  const consents = useQuery({
    queryKey: ['consents', a.patientId],
    queryFn: () => consentsApi.list(a.patientId),
    retry: false,
  });
  const grant = useSafeMutation({
    mutationFn: () =>
      consentsApi.grant({
        patientId: a.patientId,
        doctorId: a.doctorId,
        kind: 'appointment',
        appointmentId: a.id,
        scopes: SHARE_SCOPES,
        purpose: 'consultation',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['consents', a.patientId] });
      queryClient.invalidateQueries({ queryKey: ['access-log', a.patientId] });
    },
  });
  const { confirm, dialog } = useConfirm();
  const active = (consents.data ?? []).find(
    (c) => c.doctor.id === a.doctorId && c.status === 'active',
  );
  const canShare = UPCOMING.includes(a.status) || a.status === 'in_consultation';

  const share = async () => {
    const ok = await confirm({
      title: `Share your records with ${a.doctorName}?`,
      description: `${a.doctorName} will be able to see your profile and your health documents, to prepare for and conduct this consultation. Access ends automatically ${APPOINTMENT_CONSENT_GRACE_HOURS} hours after the appointment. You can revoke it at any time in Privacy & Access, and every time they open your records is listed there.`,
      confirmLabel: 'Share for this appointment',
      cancelLabel: 'Not now',
    });
    if (ok) grant.mutate();
  };

  return (
    <li className="flex gap-3 py-3">
      {active ? (
        <ShieldCheck aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-success" />
      ) : (
        <Lock aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-text-subtle" />
      )}
      <div className="min-w-0 flex-1 text-sm">
        {dialog}
        <p className="font-medium text-text">
          {active ? `Shared with ${a.doctorName}` : 'Your records are private'}
        </p>
        {consents.isPending && <p className="text-text-muted">Checking…</p>}
        {active && (
          <p className="text-text-muted">
            They can see: {active.scopes.map((s) => SCOPE_LABELS[s]).join(', ')}, until{' '}
            {formatDateTime(active.expiresAt)}.{' '}
            <Link to="/app/privacy" className="font-medium text-primary hover:text-primary-hover">
              Change or revoke
            </Link>
          </p>
        )}
        {consents.isSuccess && !active && (
          <>
            <p className="text-text-muted">
              {a.doctorName} can’t see your documents.{' '}
              {canShare
                ? 'Sharing them helps your doctor prepare. It is optional.'
                : 'Sharing is only possible for an upcoming appointment.'}
            </p>
            {canShare && (
              <Button
                className="mt-2"
                size="sm"
                variant="secondary"
                icon={ShieldCheck}
                onClick={share}
                loading={grant.isPending}
              >
                Share for this appointment
              </Button>
            )}
          </>
        )}
        {grant.isError && (
          <Alert tone="error" className="mt-2">
            {authErrorMessage(grant.error)}
          </Alert>
        )}
      </div>
    </li>
  );
}

function ReportsItem({ a }) {
  const documents = useQuery({
    queryKey: ['documents', a.patientId],
    queryFn: () => recordsApi.list(a.patientId),
    retry: false,
  });
  const available = (documents.data ?? []).filter((d) => d.status === 'available').length;
  return (
    <li className="flex gap-3 py-3">
      <FileText
        aria-hidden="true"
        className={`mt-0.5 h-5 w-5 shrink-0 ${available ? 'text-success' : 'text-text-subtle'}`}
      />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium text-text">
          {documents.isSuccess
            ? available
              ? `${available} report${available === 1 ? '' : 's'} in your records`
              : 'No reports uploaded yet'
            : 'Reports'}
        </p>
        <p className="text-text-muted">
          Recent lab reports, prescriptions or scans help your doctor. Upload them in Health
          Records.
        </p>
        <ButtonLink
          as={Link}
          to="/app/records"
          className="mt-2"
          size="sm"
          variant="secondary"
          icon={Upload}
        >
          {available ? 'Add another report' : 'Upload a report'}
        </ButtonLink>
      </div>
    </li>
  );
}

function FollowUpsForVisit({ a, consultationId }) {
  const list = useQuery({
    queryKey: ['follow-ups', a.patientId],
    queryFn: () => followUpApi.forPatient(a.patientId),
    retry: false,
  });
  const mine = (list.data ?? []).filter(
    (f) => f.appointmentId === a.id || (consultationId && f.consultationId === consultationId),
  );
  if (!mine.length) return null;
  return (
    <Card>
      <SectionHeader
        icon={HeartPulse}
        title="Follow-up"
        description="Your doctor asked to hear how you are doing after this consultation."
      />
      <ul className="mt-3 divide-y divide-border">
        {mine.map((f) => (
          <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
            <span className="text-sm text-text">
              Check-in {f.status === 'scheduled' ? 'opens' : 'due'} {formatDateOnly(f.dueOn)}
            </span>
            <span className="flex items-center gap-2">
              <StatusBadge
                status={f.status}
                label={f.status === 'awaiting_response' ? 'Your answer needed' : undefined}
              />
              {f.status === 'awaiting_response' && (
                <ButtonLink as={Link} to="/app/follow-ups" size="sm">
                  Answer now
                </ButtonLink>
              )}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Manage({ a, now }) {
  const queryClient = useQueryClient();
  const cancel = useSafeMutation({
    mutationFn: () => schedulingApi.cancel(a.id, 'patient_request'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['appointments'] });
      queryClient.invalidateQueries({ queryKey: ['appointment', a.id] });
      queryClient.invalidateQueries({ queryKey: ['consultation', a.id] });
      queryClient.invalidateQueries({ queryKey: ['consultation-status', a.id] });
    },
  });
  const { confirm, dialog } = useConfirm();
  if (!['confirmed', 'pending_payment'].includes(a.status)) return null;
  const hoursAhead = (new Date(a.startsAt).getTime() - now) / 3_600_000;
  if (hoursAhead <= 0) return null;
  const refundNote =
    a.feePaise > 0 && a.paymentStatus === 'paid'
      ? hoursAhead >= PATIENT_FULL_REFUND_HOURS
        ? 'You will get a full refund, because it is more than 24 hours away.'
        : 'It starts in less than 24 hours, so the payment will not be refunded.'
      : 'You can book another time afterwards.';
  const onCancel = async () => {
    const ok = await confirm({
      title: 'Cancel this appointment?',
      description: `${formatDateTime(a.startsAt)} with ${a.doctorName}. ${refundNote}`,
      confirmLabel: 'Cancel appointment',
      cancelLabel: 'Keep it',
      destructive: true,
      tone: 'warning',
    });
    if (ok) cancel.mutate();
  };
  return (
    <Card>
      {dialog}
      <SectionHeader
        title="Need to change something?"
        description={
          a.feePaise > 0
            ? `Cancel at least ${PATIENT_FULL_REFUND_HOURS} hours before the start for a full refund. Later cancellations are not refunded.`
            : 'You can reschedule or cancel before the appointment starts.'
        }
      />
      {cancel.isError && (
        <Alert tone="error" className="mt-3">
          {authErrorMessage(cancel.error)}
        </Alert>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <ButtonLink
          as={Link}
          variant="secondary"
          icon={CalendarClock}
          to={`/app/appointments/book?rescheduleId=${a.id}&doctorId=${a.doctorId}&mode=${a.mode}`}
        >
          Reschedule
        </ButtonLink>
        <Button variant="ghost" onClick={onCancel} loading={cancel.isPending}>
          Cancel appointment
        </Button>
      </div>
    </Card>
  );
}

/**
 * The patient's appointment page: the single place for everything about one visit —
 * state, payment, record sharing, the waiting room and video, and afterwards the
 * summary, prescriptions and follow-up.
 */
export function PatientAppointment({ view, status, appointmentId, notice }) {
  const [now] = useState(() => Date.now());
  const details = useQuery({
    queryKey: ['appointment', appointmentId],
    queryFn: () => schedulingApi.get(appointmentId),
    retry: false,
    refetchInterval: (q) => (q.state.data?.status === 'pending_payment' ? 15_000 : false),
  });
  const v = view.appointment;
  const d = details.data ?? {};
  // The consultation view is authoritative for the visit; the appointment adds payment,
  // fee, reason and reference.
  const a = {
    ...v,
    id: appointmentId,
    status: status?.appointmentStatus ?? v.status,
    paymentStatus: d.paymentStatus,
    feePaise: d.feePaise,
    reference: d.reference,
    reason: d.reason,
    holdExpiresAt: d.holdExpiresAt,
    cancelledAt: d.cancelledAt,
    cancelledByParty: d.cancelledByParty,
    doctorSpecialization: d.doctor?.primarySpecialization,
  };
  const c = view.consultation;
  const signedNotes = view.notes.filter((n) => n.status === 'signed');
  const earlierNotes = view.notes.filter((n) => n.status !== 'signed');
  const upcoming = UPCOMING.includes(a.status) && !c;

  return (
    <div className="space-y-6">
      <PageHeader
        icon={a.mode === 'online' ? Video : Building2}
        eyebrow="Appointment"
        title={`${formatDay(a.startsAt)}, ${formatTime(a.startsAt)}`}
        description={`${MODE_LABELS[a.mode]} consultation with ${a.doctorName}${
          a.clinicName ? ` · ${a.clinicName}` : ''
        }`}
      >
        <div className="mt-2 flex flex-wrap gap-2">
          <StatusBadge status={a.status} />
          {c?.status === 'live' && <StatusBadge status="live" />}
        </div>
      </PageHeader>
      <LoadError queries={[details]} what="the payment and booking details" />
      {notice && <Alert tone="success">{notice}</Alert>}
      {status?.emergencyGuidance && <EmergencyGuidance guidance={status.emergencyGuidance} />}
      <NowPanel a={a} view={view} status={status} appointmentId={appointmentId} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Details a={a} />
        {upcoming || c?.status === 'live' ? (
          <Card>
            <SectionHeader
              icon={CheckCircle2}
              title="Before your consultation"
              description="Optional, but it helps your doctor help you."
            />
            <ul className="mt-2 divide-y divide-border">
              <SharingItem a={a} />
              <ReportsItem a={a} />
            </ul>
          </Card>
        ) : (
          <Card>
            <SectionHeader icon={ShieldCheck} title="Your records" />
            <ul className="mt-2 divide-y divide-border">
              <SharingItem a={a} />
            </ul>
          </Card>
        )}
      </div>

      {signedNotes.length > 0 && (
        <Card>
          <SectionHeader
            icon={FileText}
            title="Consultation summary"
            description={`Signed by ${a.doctorName}. Signed notes can’t be edited; corrections appear as a new version.`}
          />
          <div className="mt-4 space-y-4">
            {signedNotes.map((n) => (
              <NoteView key={n.id} note={n} patient />
            ))}
          </div>
          {earlierNotes.length > 0 && (
            <details className="mt-4">
              <summary className="cursor-pointer text-sm text-text-muted">
                Earlier versions ({earlierNotes.length})
              </summary>
              <div className="mt-3 space-y-4 opacity-80">
                {earlierNotes.map((n) => (
                  <NoteView key={n.id} note={n} patient />
                ))}
              </div>
            </details>
          )}
        </Card>
      )}
      {view.prescriptions.length > 0 && (
        <Card>
          <SectionHeader icon={Pill} title="Prescription" />
          <div className="mt-4">
            <PrescriptionList prescriptions={view.prescriptions} />
          </div>
        </Card>
      )}
      <FollowUpsForVisit a={a} consultationId={c?.id} />
      <Manage a={a} now={now} />
    </div>
  );
}
