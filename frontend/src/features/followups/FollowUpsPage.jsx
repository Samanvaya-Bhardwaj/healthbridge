import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FOLLOW_UP_RED_FLAGS } from '@healthbridge/shared';
import { useAuth } from '../auth/authContext.js';
import { primaryRole } from '../../app/navigation.js';
import { doctorsApi, followUpApi } from '../../lib/domainApi.js';
import { authErrorMessage } from '../auth/errorMessages.js';
import { usePatientChoice } from '../records/usePatientChoice.js';
import { PatientSelect } from '../records/PatientSelect.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { Badge, StatusBadge } from '../../components/ui/Badge.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { Card } from '../../components/ui/Card.jsx';
import { EmptyState, LoadingState } from '../../components/ui/EmptyState.jsx';
import { SelectField } from '../../components/ui/SelectField.jsx';
import { Skeleton } from '../../components/ui/Skeleton.jsx';
import { TextField } from '../../components/ui/TextField.jsx';
import { PageHeader } from '../../components/ui/Typography.jsx';
import {
  AlertTriangle,
  CheckCircle2,
  Sparkles,
  Frown,
  HeartPulse,
  Meh,
  Phone,
  Smile,
} from 'lucide-react';
import { Tabs } from '../../components/ui/Tabs.jsx';
import { Link, useSearchParams } from 'react-router';
import { ButtonLink } from '../../components/ui/Button.jsx';
import { TextAreaField } from '../../components/ui/Fields.jsx';
import { MissingProfileNotice } from '../patients/MissingProfileNotice.jsx';
import { formatDateOnly, formatDateTime } from '../appointments/format.js';

const OVERALL = [
  ['better', 'Better'],
  ['same', 'About the same'],
  ['worse', 'Worse'],
];
const ESCALATION_TONES = { urgent: 'danger', attention: 'warning', none: 'neutral' };
const STATUS_LABELS = {
  scheduled: 'Scheduled',
  awaiting_response: 'Waiting for answer',
  responded: 'Answered',
  needs_attention: 'Needs attention',
  urgent: 'Urgent',
  closed: 'Closed',
  cancelled: 'Cancelled',
};

function EmergencyGuidance({ guidance }) {
  return (
    <div role="alert" className="rounded-xl border-2 border-danger bg-danger/10 p-5">
      <h2 className="text-lg font-semibold text-danger">{guidance.title}</h2>
      {guidance.lines.map((line) => (
        <p key={line} className="mt-2 text-text">
          {line}
        </p>
      ))}
      <a
        href="tel:112"
        className="mt-4 inline-flex min-h-11 items-center rounded-lg bg-danger px-4 py-2.5 text-sm font-medium text-white"
      >
        Call 112
      </a>
    </div>
  );
}

// ── Patient ─────────────────────────────────────────────────────────

const OVERALL_ICONS = { better: Smile, same: Meh, worse: Frown };

function CheckInForm({ followUp, onDone }) {
  const [overall, setOverall] = useState('');
  const [redFlags, setRedFlags] = useState([]);
  const [note, setNote] = useState('');
  const respond = useMutation({
    mutationFn: () => followUpApi.respond(followUp.id, { overall, redFlags, note }),
    onSuccess: onDone,
  });
  const toggle = (code) =>
    setRedFlags((list) => (list.includes(code) ? list.filter((c) => c !== code) : [...list, code]));
  return (
    <form
      className="mt-5 space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        if (overall) respond.mutate();
      }}
    >
      <fieldset>
        <legend className="text-sm font-semibold text-text">
          1. How do you feel compared with your consultation?
        </legend>
        <div className="mt-3 grid grid-cols-3 gap-2">
          {OVERALL.map(([value, label]) => {
            const Icon = OVERALL_ICONS[value];
            const checked = overall === value;
            return (
              <label
                key={value}
                className={`flex min-h-20 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border p-3 text-center text-sm has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-primary ${
                  checked
                    ? 'border-primary bg-primary-soft font-medium text-primary'
                    : 'border-border text-text hover:border-primary/40'
                }`}
              >
                <input
                  type="radio"
                  name={`overall-${followUp.id}`}
                  value={value}
                  checked={checked}
                  onChange={() => setOverall(value)}
                  className="sr-only"
                />
                <Icon aria-hidden="true" className="h-6 w-6" />
                {label}
              </label>
            );
          })}
        </div>
      </fieldset>
      <fieldset className="rounded-xl border border-danger/30 bg-danger/5 p-4">
        <legend className="px-1 text-sm font-semibold text-text">
          2. Do you have any of these right now?
        </legend>
        <p className="text-sm text-text-muted">
          These can be signs of an emergency. Tick any that apply; leave all unticked if none do.
        </p>
        <div className="mt-2 grid gap-1 sm:grid-cols-2">
          {Object.entries(FOLLOW_UP_RED_FLAGS).map(([code, label]) => (
            <label key={code} className="flex min-h-11 items-center gap-2 text-sm text-text">
              <input
                type="checkbox"
                checked={redFlags.includes(code)}
                onChange={() => toggle(code)}
                className="h-5 w-5 shrink-0 accent-primary"
              />
              {label}
            </label>
          ))}
        </div>
        <p aria-live="polite" className="text-sm font-medium text-danger">
          {redFlags.length > 0 &&
            'If you have this now, call 112 or 108 straight away. Don’t wait for your doctor’s reply.'}
        </p>
      </fieldset>
      <TextAreaField
        label="3. Anything else for your doctor? (optional)"
        rows={3}
        maxLength={1000}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      {respond.isError && <Alert tone="error">{authErrorMessage(respond.error)}</Alert>}
      {!overall && (
        <p className="text-sm text-text-muted">Answer question 1 to send your check-in.</p>
      )}
      <Button type="submit" disabled={!overall} loading={respond.isPending}>
        Send check-in
      </Button>
    </form>
  );
}

/** One sentence per state: what it means for the patient, and anything to do. */
function stateText(f) {
  switch (f.status) {
    case 'scheduled':
      return `This check-in opens on ${formatDateOnly(f.dueOn)}. You’ll get a notification.`;
    case 'responded':
      return `Sent. ${f.doctorName} will read your answers.`;
    case 'needs_attention':
      return `Sent. ${f.doctorName} will review your answers soon. If you feel worse, don’t wait: call 112 or 108.`;
    case 'closed':
      return `Closed by ${f.doctorName}${f.closedAt ? ` on ${formatDateTime(f.closedAt)}` : ''}.`;
    case 'cancelled':
      return 'This check-in was cancelled.';
    default:
      return null;
  }
}

const PATIENT_ORDER = ['urgent', 'awaiting_response', 'needs_attention', 'responded', 'scheduled'];

function PatientFollowUpCard({ f, onDone }) {
  const ask = f.status === 'awaiting_response';
  return (
    <Card className={ask ? 'border-primary/40' : f.status === 'urgent' ? 'border-danger/50' : ''}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-text">Check-in from {f.doctorName}</p>
          <p className="text-sm text-text-muted">
            {f.status === 'scheduled' ? 'Opens' : 'Due'} {formatDateOnly(f.dueOn)}
          </p>
        </div>
        <StatusBadge
          status={f.status}
          label={ask ? 'Your answer needed' : STATUS_LABELS[f.status]}
        />
      </div>
      {ask && (
        <p className="mt-3 text-sm text-text">
          {f.doctorName} asked how you are doing since your consultation. It takes under a minute,
          and only your doctor reads your answers.
        </p>
      )}
      {f.status === 'urgent' && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-danger/10 p-3">
          <p className="text-sm font-medium text-danger">
            You reported a warning sign. If you haven’t already, call 112 or go to the nearest
            emergency department now.
          </p>
          <a
            href="tel:112"
            className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-danger px-4 text-sm font-medium text-white"
          >
            <Phone aria-hidden="true" className="h-4 w-4" />
            Call 112
          </a>
        </div>
      )}
      {stateText(f) && <p className="mt-3 text-sm text-text-muted">{stateText(f)}</p>}
      {f.response && (
        <p className="mt-2 text-sm text-text-muted">
          Your answer: {OVERALL.find(([v]) => v === f.response.overall)?.[1] ?? f.response.overall}
          {f.response.redFlags?.length > 0 &&
            ` · ${f.response.redFlags.map((r) => r.label).join(', ')}`}
        </p>
      )}
      {ask && <CheckInForm followUp={f} onDone={onDone} />}
    </Card>
  );
}

function PatientFollowUps() {
  const queryClient = useQueryClient();
  const { choices, patientId, setPatientId, isPending, missingProfile } = usePatientChoice();
  const [guidance, setGuidance] = useState(null);
  const list = useQuery({
    queryKey: ['follow-ups', patientId],
    queryFn: () => followUpApi.forPatient(patientId),
    enabled: Boolean(patientId),
  });
  const done = (result) => {
    setGuidance(result.emergencyGuidance ?? null);
    queryClient.invalidateQueries({ queryKey: ['follow-ups', patientId] });
  };
  if (missingProfile) return <MissingProfileNotice />;
  const items = list.data ?? [];
  const open = items
    .filter((f) => PATIENT_ORDER.includes(f.status))
    .sort((a, b) => PATIENT_ORDER.indexOf(a.status) - PATIENT_ORDER.indexOf(b.status));
  const past = items.filter((f) => !PATIENT_ORDER.includes(f.status));
  const waiting = items.filter((f) => f.status === 'awaiting_response').length;
  return (
    <div className="space-y-6">
      <PageHeader
        icon={HeartPulse}
        eyebrow="My care"
        title="Follow-ups"
        description="After a consultation, your doctor may ask how you are. Answer a few quick questions; your doctor reads them. If you feel very unwell, don’t wait: call 112 or 108."
        actions={<PatientSelect choices={choices} value={patientId} onChange={setPatientId} />}
      />
      {guidance && <EmergencyGuidance guidance={guidance} />}
      {waiting > 0 && !guidance && (
        <Alert tone="info" title={`${waiting} check-in${waiting === 1 ? '' : 's'} waiting for you`}>
          Answer below. It takes under a minute.
        </Alert>
      )}
      {(isPending || list.isPending) && <LoadingState label="Loading check-ins" rows={2} />}
      {list.isError && <Alert tone="error">{authErrorMessage(list.error)}</Alert>}
      {list.isSuccess && items.length === 0 && (
        <EmptyState
          icon={HeartPulse}
          title="No check-ins yet"
          action={
            <ButtonLink as={Link} to="/app/appointments" variant="secondary">
              Go to appointments
            </ButtonLink>
          }
        >
          After a consultation, your doctor can schedule a short check-in to see how you are doing.
          It will appear here, and you’ll get a notification.
        </EmptyState>
      )}
      <ul className="space-y-3">
        {open.map((f) => (
          <li key={f.id}>
            <PatientFollowUpCard f={f} onDone={done} />
          </li>
        ))}
      </ul>
      {past.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm text-text-muted">
            Past check-ins ({past.length})
          </summary>
          <ul className="mt-3 space-y-3">
            {past.map((f) => (
              <li key={f.id}>
                <PatientFollowUpCard f={f} onDone={done} />
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

// ── Doctor ──────────────────────────────────────────────────────────

function ScheduleForm({ onDone }) {
  const patients = useQuery({
    queryKey: ['doctors', 'patients'],
    queryFn: () => doctorsApi.myPatients(),
  });
  const active = (patients.data ?? []).filter((r) => r.status === 'active');
  const [patientId, setPatientId] = useState('');
  const [dueOn, setDueOn] = useState('');
  const schedule = useMutation({
    mutationFn: () => followUpApi.schedule(patientId, { dueOn }),
    onSuccess: () => {
      setDueOn('');
      onDone();
    },
  });
  return (
    <Card>
      <h2 className="text-base font-semibold text-text">Schedule a check-in</h2>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <SelectField
          className="min-w-56"
          label="Patient"
          placeholder="Choose a patient"
          value={patientId}
          options={active.map((r) => ({
            value: r.patient.id,
            label: r.patient.fullName ?? r.patient.displayName,
          }))}
          onChange={(e) => setPatientId(e.target.value)}
        />
        <TextField
          type="date"
          label="Due on"
          value={dueOn}
          onChange={(e) => setDueOn(e.target.value)}
        />
        <Button
          disabled={!patientId || !dueOn || schedule.isPending}
          onClick={() => schedule.mutate()}
        >
          Schedule
        </Button>
      </div>
      {schedule.isError && <Alert tone="error">{authErrorMessage(schedule.error)}</Alert>}
    </Card>
  );
}

function FollowUpDetail({ id, onChanged }) {
  const detail = useQuery({ queryKey: ['follow-up', id], queryFn: () => followUpApi.get(id) });
  const close = useMutation({ mutationFn: () => followUpApi.close(id, ''), onSuccess: onChanged });
  const f = detail.data;
  if (detail.isPending) return <Skeleton className="h-16 w-full" />;
  if (detail.isError) return <Alert tone="error">{authErrorMessage(detail.error)}</Alert>;
  const open = !['closed', 'cancelled'].includes(f.status);
  return (
    <div className="mt-3 space-y-3 border-t border-border pt-3">
      {f.response ? (
        <div className="text-sm text-text">
          <p>
            Feels: <strong>{OVERALL.find(([v]) => v === f.response.overall)?.[1]}</strong>
          </p>
          {f.response.redFlags.length > 0 && (
            <p className="text-danger">
              Warning signs: {f.response.redFlags.map((r) => r.label).join(', ')}
            </p>
          )}
          {f.response.note && <p className="mt-1 whitespace-pre-wrap">Note: {f.response.note}</p>}
        </div>
      ) : (
        <p className="text-sm text-text-muted">No answer yet.</p>
      )}
      {f.summary && (
        <div className="rounded-xl border border-ai/20 bg-ai-soft/60 p-3">
          <p className="mb-1 flex items-center gap-2 text-xs text-text-muted">
            <Badge tone="ai" icon={Sparkles}>
              AI-generated
            </Badge>{' '}
            Summary of the answer above, with citations. Escalation is decided by fixed rules, not
            AI.
          </p>
          <ul className="space-y-1 text-sm text-text">
            {f.summary.sentences.map((s, i) => (
              <li key={i}>
                {s.text}{' '}
                <span className="text-xs text-text-subtle">
                  [{s.citations.map((c) => c.label).join(', ')}]
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {open && (
        <Button variant="secondary" onClick={() => close.mutate()} disabled={close.isPending}>
          {f.status === 'scheduled' ? 'Cancel follow-up' : 'Close follow-up'}
        </Button>
      )}
    </div>
  );
}

/** Doctor's buckets, most urgent first. */
const DOCTOR_BUCKETS = [
  ['urgent', 'Urgent', ['urgent']],
  ['attention', 'Needs attention', ['needs_attention']],
  ['answered', 'Answered', ['responded']],
  ['waiting', 'Waiting for patient', ['scheduled', 'awaiting_response']],
  ['closed', 'Closed', ['closed', 'cancelled']],
];
const BUCKET_HELP = {
  urgent: 'The patient reported a warning sign and was shown emergency guidance immediately.',
  attention:
    'Answers the fixed rules flagged for your review (for example, feeling worse, or no answer after reminders).',
  answered: 'Answered with nothing flagged. Review and close.',
  waiting: 'Not due yet, or waiting for the patient to answer.',
  closed: 'Reviewed and closed, or cancelled.',
};

function DoctorFollowUps() {
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const [openId, setOpenId] = useState(() => params.get('open'));
  const [scheduling, setScheduling] = useState(false);
  const list = useQuery({
    queryKey: ['doctor-follow-ups', 'all'],
    queryFn: () => followUpApi.forDoctor(),
  });
  const items = list.data ?? [];
  const counts = Object.fromEntries(
    DOCTOR_BUCKETS.map(([key, , statuses]) => [
      key,
      items.filter((f) => statuses.includes(f.status)).length,
    ]),
  );
  const target = items.find((f) => f.id === openId);
  const firstWithItems = DOCTOR_BUCKETS.find(([key]) => counts[key] > 0)?.[0] ?? 'urgent';
  const [chosen, setBucket] = useState(null);
  const bucket =
    chosen ??
    (target && DOCTOR_BUCKETS.find(([, , st]) => st.includes(target.status))?.[0]) ??
    firstWithItems;
  const statuses = DOCTOR_BUCKETS.find(([key]) => key === bucket)[2];
  const shown = items
    .filter((f) => statuses.includes(f.status))
    .sort((x, y) => x.dueOn.localeCompare(y.dueOn));
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['doctor-follow-ups'] });
    queryClient.invalidateQueries({ queryKey: ['follow-up'] });
  };
  return (
    <div className="space-y-6">
      <PageHeader
        icon={HeartPulse}
        eyebrow="Clinical work"
        title="Follow-ups"
        description="Check-ins after consultations, urgent first. Warning signs are escalated by fixed rules, never by AI."
        actions={
          <Button variant="secondary" onClick={() => setScheduling((v) => !v)}>
            {scheduling ? 'Close' : 'Schedule a check-in'}
          </Button>
        }
      />
      {scheduling && <ScheduleForm onDone={refresh} />}
      <Tabs
        label="Follow-ups"
        value={bucket}
        onChange={setBucket}
        tabs={DOCTOR_BUCKETS.map(([key, label]) => [
          key,
          `${label}${counts[key] ? ` (${counts[key]})` : ''}`,
          key === 'urgent' ? AlertTriangle : undefined,
        ])}
      />
      <p className="text-sm text-text-muted">{BUCKET_HELP[bucket]}</p>
      {list.isPending && <LoadingState label="Loading follow-ups" rows={2} />}
      {list.isError && <Alert tone="error">{authErrorMessage(list.error)}</Alert>}
      {list.isSuccess && shown.length === 0 && (
        <EmptyState compact icon={CheckCircle2} title="Nothing here">
          {bucket === 'urgent'
            ? 'No urgent check-ins. Urgent answers appear here first.'
            : 'No follow-ups in this group.'}
        </EmptyState>
      )}
      <ul className="space-y-3">
        {shown.map((f) => (
          <li key={f.id}>
            <Card className={f.status === 'urgent' ? 'border-danger/50' : ''}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 font-medium text-text">
                    {f.patientName ?? 'Patient'}
                    <StatusBadge status={f.status} label={STATUS_LABELS[f.status]} />
                    {f.escalation.reasons.includes('no_response') && (
                      <Badge tone="warning">No answer after reminders</Badge>
                    )}
                  </p>
                  <p className="text-sm text-text-muted">
                    Due {formatDateOnly(f.dueOn)}
                    {f.respondedAt && ` · answered ${formatDateTime(f.respondedAt)}`}
                  </p>
                </div>
                <span className="flex flex-wrap gap-2">
                  <ButtonLink
                    as={Link}
                    to={`/app/medical-records/${f.patientId}`}
                    variant="ghost"
                    size="sm"
                  >
                    Patient record
                  </ButtonLink>
                  <Button
                    variant={openId === f.id ? 'ghost' : 'secondary'}
                    size="sm"
                    aria-expanded={openId === f.id}
                    onClick={() => setOpenId(openId === f.id ? null : f.id)}
                  >
                    {openId === f.id ? 'Hide' : 'Review'}
                  </Button>
                </span>
              </div>
              {openId === f.id && <FollowUpDetail id={f.id} onChanged={refresh} />}
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Follow-ups: the patient answers check-ins; the doctor schedules and reviews them. */
export function FollowUpsPage() {
  const { user } = useAuth();
  return primaryRole(user.roles) === 'DOCTOR' ? <DoctorFollowUps /> : <PatientFollowUps />;
}
