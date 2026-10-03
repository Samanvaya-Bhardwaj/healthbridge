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
import { EmptyState } from '../../components/ui/EmptyState.jsx';
import { SelectField } from '../../components/ui/SelectField.jsx';
import { Skeleton } from '../../components/ui/Skeleton.jsx';
import { TextField } from '../../components/ui/TextField.jsx';
import { controlClass } from '../../components/ui/fieldStyles.js';
import { PageHeader } from '../../components/ui/Typography.jsx';
import { HeartPulse } from 'lucide-react';

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
  needs_attention: 'Needs review',
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
      className="mt-4 space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (overall) respond.mutate();
      }}
    >
      <fieldset>
        <legend className="text-sm font-medium text-text">
          How are you feeling since the consultation?
        </legend>
        <div className="mt-2 flex flex-wrap gap-4">
          {OVERALL.map(([value, label]) => (
            <label key={value} className="flex min-h-11 items-center gap-2 text-sm text-text">
              <input
                type="radio"
                name={`overall-${followUp.id}`}
                value={value}
                checked={overall === value}
                onChange={() => setOverall(value)}
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend className="text-sm font-medium text-text">Do you have any of these now?</legend>
        <div className="mt-2 grid gap-1 sm:grid-cols-2">
          {Object.entries(FOLLOW_UP_RED_FLAGS).map(([code, label]) => (
            <label key={code} className="flex min-h-11 items-center gap-2 text-sm text-text">
              <input
                type="checkbox"
                checked={redFlags.includes(code)}
                onChange={() => toggle(code)}
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="block">
        <span className="block text-sm font-medium text-text">
          Anything else for your doctor? (optional)
        </span>
        <textarea
          className={controlClass()}
          rows={3}
          maxLength={1000}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      {respond.isError && <Alert tone="error">{authErrorMessage(respond.error)}</Alert>}
      <Button type="submit" disabled={!overall || respond.isPending}>
        {respond.isPending ? 'Sending…' : 'Send check-in'}
      </Button>
    </form>
  );
}

function PatientFollowUps() {
  const queryClient = useQueryClient();
  const { choices, patientId, setPatientId, isPending } = usePatientChoice();
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
  return (
    <div className="space-y-6">
      <PageHeader
        icon={HeartPulse}
        eyebrow="My care"
        title="Follow-ups"
        description="Short check-ins your doctor asks for after a consultation: tell them how you are. If you feel very unwell, do not wait — call 112 or 108."
        actions={<PatientSelect choices={choices} value={patientId} onChange={setPatientId} />}
      />
      {guidance && <EmergencyGuidance guidance={guidance} />}
      {(isPending || list.isPending) && <Skeleton className="h-24 w-full" />}
      {list.isError && <Alert tone="error">{authErrorMessage(list.error)}</Alert>}
      {list.data?.length === 0 && (
        <EmptyState title="No follow-ups">Your doctor's check-ins will appear here.</EmptyState>
      )}
      <ul className="space-y-3">
        {list.data?.map((f) => (
          <li key={f.id}>
            <Card>
              <p className="flex flex-wrap items-center gap-2 font-medium text-text">
                Check-in from {f.doctorName} · due {f.dueOn}
                <Badge tone={ESCALATION_TONES[f.escalation.level]}>{STATUS_LABELS[f.status]}</Badge>
              </p>
              {f.status === 'urgent' && (
                <p className="mt-2 text-sm font-medium text-danger">
                  You reported a warning sign. If you have not already, call 112 or go to the
                  nearest emergency department.
                </p>
              )}
              {f.status === 'awaiting_response' && <CheckInForm followUp={f} onDone={done} />}
              {f.status === 'scheduled' && (
                <p className="mt-2 text-sm text-text-muted">This check-in opens on {f.dueOn}.</p>
              )}
            </Card>
          </li>
        ))}
      </ul>
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
          options={active.map((r) => ({ value: r.patient.id, label: r.patient.displayName }))}
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
        <div className="rounded-lg bg-surface-muted p-3">
          <p className="mb-1 flex items-center gap-2 text-xs text-text-muted">
            <Badge tone="primary">AI-generated</Badge> Summary of the answer above, with citations.
            Escalation is decided by fixed rules, not AI.
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

function DoctorFollowUps() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState('open');
  const [openId, setOpenId] = useState(null);
  const list = useQuery({
    queryKey: ['doctor-follow-ups', filter],
    queryFn: () => followUpApi.forDoctor(filter === 'all' ? undefined : filter),
  });
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
        description="Check-ins after consultations. Urgent answers come first; warning signs are escalated by fixed rules, never by AI."
      />
      <ScheduleForm onDone={refresh} />
      <SelectField
        className="max-w-xs"
        label="Show"
        value={filter}
        options={[
          { value: 'open', label: 'Open' },
          { value: 'urgent', label: 'Urgent' },
          { value: 'needs_attention', label: 'Needs review' },
          { value: 'all', label: 'All' },
        ]}
        onChange={(e) => setFilter(e.target.value)}
      />
      {list.isPending && <Skeleton className="h-24 w-full" />}
      {list.isError && <Alert tone="error">{authErrorMessage(list.error)}</Alert>}
      {list.data?.length === 0 && <EmptyState title="No follow-ups">Nothing to review.</EmptyState>}
      <ul className="space-y-3">
        {list.data?.map((f) => (
          <li key={f.id}>
            <Card>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-text">
                  {f.patientName ?? 'Patient'} · due {f.dueOn}
                  <Badge tone={ESCALATION_TONES[f.escalation.level]}>
                    {STATUS_LABELS[f.status]}
                  </Badge>
                  {f.escalation.reasons.includes('no_response') && <StatusBadge status="pending" />}
                </p>
                <Button variant="ghost" onClick={() => setOpenId(openId === f.id ? null : f.id)}>
                  {openId === f.id ? 'Hide' : 'Review'}
                </Button>
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
