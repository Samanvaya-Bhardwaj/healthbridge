import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MAX_PRESCRIPTION_ITEMS, MEDICATION_ROUTES } from '@healthbridge/shared';
import { consultationApi } from '../../lib/domainApi.js';
import { authErrorMessage } from '../auth/errorMessages.js';
import { Alert } from '../../components/ui/Alert.jsx';
import { Badge, StatusBadge } from '../../components/ui/Badge.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { Card } from '../../components/ui/Card.jsx';
import { Skeleton } from '../../components/ui/Skeleton.jsx';
import { TextField } from '../../components/ui/TextField.jsx';
import { SelectField } from '../../components/ui/SelectField.jsx';
import { MODE_LABELS, formatDateTime } from '../appointments/format.js';
import { PrescriptionCard } from './Prescriptions.jsx';
import { VideoRoom } from './VideoRoom.jsx';

const SOAP = [
  ['subjective', 'Subjective', 'What the patient reports'],
  ['objective', 'Objective', 'Findings and observations'],
  ['assessment', 'Assessment', 'Clinical impression'],
  ['plan', 'Plan', 'Management, advice and follow-up'],
];
const OUTCOME_LABELS = {
  online_managed: 'Managed online',
  physical_visit_required: 'In-person visit needed',
  emergency_escalation: 'Emergency care advised',
};
const EMPTY_ITEM = {
  drugName: '',
  strength: '',
  form: '',
  dose: '',
  frequency: '',
  route: 'oral',
  duration: '',
  instructions: '',
};
const linkButton =
  'inline-flex min-h-11 items-center rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-contrast hover:bg-primary-hover';

function TextArea({ label, hint, value, onChange, rows = 3, maxLength = 4000 }) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-text">{label}</span>
      {hint && <span className="mt-1 block text-sm text-text-subtle">{hint}</span>}
      <textarea
        className="mt-1.5 block w-full rounded-lg border border-border bg-surface-raised px-3.5 py-2.5 text-text"
        rows={rows}
        maxLength={maxLength}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function ErrorAlert({ error }) {
  if (!error) return null;
  const fieldErrors = error.errors?.map((e) => e.message) ?? [];
  return (
    <Alert tone="error">
      {authErrorMessage(error)}
      {fieldErrors.length > 0 && (
        <ul className="mt-1 list-disc pl-5">
          {fieldErrors.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}
    </Alert>
  );
}

// ── Shared pieces ───────────────────────────────────────────────────

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

function NoteView({ note }) {
  return (
    <div className="space-y-2">
      <p className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
        <StatusBadge status={note.status} /> Version {note.version}
        {note.signedAt && ` · signed ${formatDateTime(note.signedAt)}`}
      </p>
      {note.correctionReason && (
        <p className="text-xs text-text-muted">Correction: {note.correctionReason}</p>
      )}
      <dl className="grid gap-2 sm:grid-cols-2">
        {SOAP.filter(([key]) => note.note[key]).map(([key, label]) => (
          <div key={key}>
            <dt className="text-xs font-semibold uppercase text-text-subtle">{label}</dt>
            <dd className="whitespace-pre-wrap text-sm text-text">{note.note[key]}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function VideoPanel({ appointmentId }) {
  const join = useMutation({ mutationFn: () => consultationApi.join(appointmentId) });
  return (
    <div className="rounded-lg border border-border bg-surface-muted p-4">
      {!join.data ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-text">The video room is open.</p>
          <Button onClick={() => join.mutate()} disabled={join.isPending}>
            {join.isPending ? 'Joining…' : 'Join video'}
          </Button>
        </div>
      ) : join.data.provider === 'mock' ? (
        <div className="grid h-48 place-items-center rounded-lg bg-black/80 text-center text-sm text-white">
          <div>
            <p className="font-medium">Demo video room</p>
            <p className="mt-1 text-white/70">
              The mock provider issues a real, short-lived join token but carries no audio or video.
              Start with live video (npm start -- --video) for real calls.
            </p>
          </div>
        </div>
      ) : (
        <VideoRoom url={join.data.url} token={join.data.token} onLeave={() => join.reset()} />
      )}
      <ErrorAlert error={join.error} />
    </div>
  );
}

// ── Doctor ──────────────────────────────────────────────────────────

function NoteEditor({ appointmentId, draft, onSaved }) {
  const [note, setNote] = useState(
    () => draft?.note ?? { subjective: '', objective: '', assessment: '', plan: '' },
  );
  const save = useMutation({
    mutationFn: () => consultationApi.saveNote(appointmentId, note),
    onSuccess: onSaved,
  });
  const sign = useMutation({
    mutationFn: async () => {
      await consultationApi.saveNote(appointmentId, note);
      return consultationApi.signNote(appointmentId);
    },
    onSuccess: onSaved,
  });
  const empty = Object.values(note).every((v) => !v.trim());
  return (
    <div className="space-y-3">
      {SOAP.map(([key, label, hint]) => (
        <TextArea
          key={key}
          label={label}
          hint={hint}
          value={note[key]}
          onChange={(v) => setNote((n) => ({ ...n, [key]: v }))}
        />
      ))}
      <ErrorAlert error={save.error ?? sign.error} />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          disabled={empty || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Saving…' : 'Save draft'}
        </Button>
        <Button
          disabled={empty || sign.isPending}
          onClick={() => {
            if (window.confirm('Sign this note? Signed notes cannot be edited, only corrected.')) {
              sign.mutate();
            }
          }}
        >
          Sign note
        </Button>
      </div>
    </div>
  );
}

function NoteCorrection({ note, onSaved }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(note.note);
  const [reason, setReason] = useState('');
  const correct = useMutation({
    mutationFn: () => consultationApi.correctNote(note.id, { note: draft, reason }),
    onSuccess: (data) => {
      setOpen(false);
      onSaved(data);
    },
  });
  if (!open) {
    return (
      <Button variant="ghost" onClick={() => setOpen(true)}>
        Correct note
      </Button>
    );
  }
  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      {SOAP.map(([key, label]) => (
        <TextArea
          key={key}
          label={label}
          value={draft[key]}
          onChange={(v) => setDraft((n) => ({ ...n, [key]: v }))}
        />
      ))}
      <TextField
        label="Reason for the correction"
        value={reason}
        maxLength={500}
        onChange={(e) => setReason(e.target.value)}
      />
      <ErrorAlert error={correct.error} />
      <div className="flex gap-2">
        <Button
          disabled={reason.trim().length < 5 || correct.isPending}
          onClick={() => correct.mutate()}
        >
          Sign correction
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function PrescriptionBuilder({ initial, submitLabel, needsReason, onSubmit, pending, error }) {
  const [items, setItems] = useState(() =>
    initial?.items?.length ? initial.items.map(({ position: _p, ...i }) => i) : [{ ...EMPTY_ITEM }],
  );
  const [advice, setAdvice] = useState(initial?.advice ?? '');
  const [reason, setReason] = useState('');
  const update = (index, key, value) =>
    setItems((list) => list.map((item, i) => (i === index ? { ...item, [key]: value } : item)));
  const complete = items.every(
    (i) =>
      i.drugName.trim().length >= 2 && i.dose.trim() && i.frequency.trim() && i.duration.trim(),
  );
  return (
    <div className="space-y-4">
      {items.map((item, index) => (
        <fieldset key={index} className="rounded-lg border border-border p-3">
          <legend className="px-1 text-sm font-medium text-text">Medicine {index + 1}</legend>
          <div className="grid gap-3 sm:grid-cols-3">
            <TextField
              label="Medicine"
              value={item.drugName}
              maxLength={120}
              onChange={(e) => update(index, 'drugName', e.target.value)}
            />
            <TextField
              label="Strength"
              value={item.strength}
              maxLength={60}
              onChange={(e) => update(index, 'strength', e.target.value)}
            />
            <TextField
              label="Form"
              value={item.form}
              maxLength={40}
              onChange={(e) => update(index, 'form', e.target.value)}
            />
            <TextField
              label="Dose"
              value={item.dose}
              maxLength={60}
              onChange={(e) => update(index, 'dose', e.target.value)}
            />
            <TextField
              label="How often"
              value={item.frequency}
              maxLength={60}
              onChange={(e) => update(index, 'frequency', e.target.value)}
            />
            <TextField
              label="For how long"
              value={item.duration}
              maxLength={60}
              onChange={(e) => update(index, 'duration', e.target.value)}
            />
            <SelectField
              label="Route"
              value={item.route}
              options={MEDICATION_ROUTES.map((r) => ({ value: r, label: r }))}
              onChange={(e) => update(index, 'route', e.target.value)}
            />
            <TextField
              className="sm:col-span-2"
              label="Instructions"
              value={item.instructions}
              maxLength={300}
              onChange={(e) => update(index, 'instructions', e.target.value)}
            />
          </div>
          {items.length > 1 && (
            <Button
              variant="ghost"
              onClick={() => setItems((list) => list.filter((_, i) => i !== index))}
            >
              Remove
            </Button>
          )}
        </fieldset>
      ))}
      {items.length < MAX_PRESCRIPTION_ITEMS && (
        <Button variant="ghost" onClick={() => setItems((list) => [...list, { ...EMPTY_ITEM }])}>
          Add medicine
        </Button>
      )}
      <TextArea label="Advice" value={advice} onChange={setAdvice} rows={2} maxLength={2000} />
      {needsReason && (
        <TextField
          label="Reason for the correction"
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
        />
      )}
      <ErrorAlert error={error} />
      <Button
        disabled={!complete || pending || (needsReason && reason.trim().length < 5)}
        onClick={() => onSubmit({ items, advice, ...(needsReason ? { reason } : {}) })}
      >
        {submitLabel}
      </Button>
    </div>
  );
}

function PrescriptionSection({ appointmentId, prescriptions, live, onSaved }) {
  const draft = prescriptions.find((p) => p.status === 'draft');
  const current = prescriptions.find((p) => p.status === 'signed');
  const [correcting, setCorrecting] = useState(false);
  const save = useMutation({
    mutationFn: (body) => consultationApi.saveDraft(appointmentId, body),
    onSuccess: () => onSaved(),
  });
  const sign = useMutation({
    mutationFn: (id) => consultationApi.signPrescription(id),
    onSuccess: () => onSaved(),
  });
  const correct = useMutation({
    mutationFn: (body) => consultationApi.correctPrescription(current.id, body),
    onSuccess: () => {
      setCorrecting(false);
      onSaved();
    },
  });
  return (
    <div className="space-y-4">
      {prescriptions
        .filter((p) => p.status !== 'draft')
        .map((rx) => (
          <PrescriptionCard key={rx.id} rx={rx} />
        ))}
      {live && !current && (
        <>
          <PrescriptionBuilder
            key={draft?.id ?? 'new'}
            initial={draft}
            submitLabel={save.isPending ? 'Saving…' : 'Save draft'}
            onSubmit={(body) => save.mutate(body)}
            pending={save.isPending}
            error={save.error}
          />
          {draft && (
            <div className="flex flex-wrap items-center gap-3 rounded-lg bg-surface-muted p-3">
              <p className="text-sm text-text">
                Draft {draft.reference} with {draft.items.length} medicine
                {draft.items.length === 1 ? '' : 's'} saved.
              </p>
              <Button
                onClick={() => {
                  if (window.confirm('Sign this prescription? It cannot be edited afterwards.')) {
                    sign.mutate(draft.id);
                  }
                }}
                disabled={sign.isPending}
              >
                Sign prescription
              </Button>
              <ErrorAlert error={sign.error} />
            </div>
          )}
        </>
      )}
      {current &&
        (correcting ? (
          <PrescriptionBuilder
            initial={current}
            needsReason
            submitLabel="Sign correction"
            onSubmit={(body) => correct.mutate(body)}
            pending={correct.isPending}
            error={correct.error}
          />
        ) : (
          <Button variant="ghost" onClick={() => setCorrecting(true)}>
            Correct prescription
          </Button>
        ))}
      {!live && !current && prescriptions.length === 0 && (
        <p className="text-sm text-text-muted">No prescription was issued.</p>
      )}
    </div>
  );
}

function OutcomePanel({ appointmentId, hasSignedNote, onSaved }) {
  const [outcome, setOutcome] = useState('online_managed');
  const [followUpOn, setFollowUpOn] = useState('');
  const [visitNote, setVisitNote] = useState('');
  const [confirm, setConfirm] = useState(false);
  const record = useMutation({
    mutationFn: () =>
      consultationApi.outcome(
        appointmentId,
        outcome === 'online_managed'
          ? { outcome, ...(followUpOn ? { followUpOn } : {}) }
          : outcome === 'physical_visit_required'
            ? { outcome, visitNote }
            : { outcome, confirm: true },
      ),
    onSuccess: onSaved,
  });
  const ready = outcome === 'emergency_escalation' ? confirm : hasSignedNote;
  return (
    <div className="space-y-3">
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-text">Outcome</legend>
        {Object.entries(OUTCOME_LABELS).map(([value, label]) => (
          <label key={value} className="flex min-h-11 items-center gap-2 text-sm text-text">
            <input
              type="radio"
              name="outcome"
              value={value}
              checked={outcome === value}
              onChange={() => setOutcome(value)}
            />
            {label}
          </label>
        ))}
      </fieldset>
      {outcome === 'online_managed' && (
        <TextField
          type="date"
          label="Follow-up on (optional)"
          value={followUpOn}
          onChange={(e) => setFollowUpOn(e.target.value)}
        />
      )}
      {outcome === 'physical_visit_required' && (
        <TextArea
          label="Note for the patient (optional)"
          value={visitNote}
          onChange={setVisitNote}
          rows={2}
          maxLength={500}
        />
      )}
      {outcome === 'emergency_escalation' && (
        <label className="flex items-start gap-2 text-sm text-text">
          <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
          I confirm the patient needs emergency care now. They will see emergency instructions (call
          112) immediately.
        </label>
      )}
      {!hasSignedNote && outcome !== 'emergency_escalation' && (
        <p className="text-sm text-text-muted">Sign the consultation note first.</p>
      )}
      <ErrorAlert error={record.error} />
      <Button
        variant={outcome === 'emergency_escalation' ? 'danger' : 'primary'}
        disabled={!ready || record.isPending}
        onClick={() => record.mutate()}
      >
        Record outcome and end consultation
      </Button>
    </div>
  );
}

function DoctorView({ view, status, appointmentId, refresh }) {
  const start = useMutation({
    mutationFn: () => consultationApi.start(appointmentId),
    onSuccess: refresh,
  });
  const c = view.consultation;
  const live = c?.status === 'live';
  const draft = view.notes.find((n) => n.status === 'draft');
  const current = view.notes.find((n) => n.status === 'signed');
  const canStart = ['confirmed', 'checked_in'].includes(view.appointment.status);
  return (
    <div className="space-y-4">
      {!c && (
        <Card>
          <p className="text-sm text-text">
            {view.appointment.mode === 'online'
              ? status?.waitingRoom.patientPresent
                ? 'The patient is in the waiting room.'
                : 'The patient has not joined the waiting room yet.'
              : 'Start once the patient has checked in at the clinic.'}
          </p>
          <ErrorAlert error={start.error} />
          {canStart && (
            <Button className="mt-3" onClick={() => start.mutate()} disabled={start.isPending}>
              Start consultation
            </Button>
          )}
        </Card>
      )}
      {live && c.video && <VideoPanel appointmentId={appointmentId} />}
      {c && (
        <Card>
          <h2 className="mb-3 text-base font-semibold text-text">Consultation note (SOAP)</h2>
          {live && !current ? (
            <NoteEditor
              key={draft?.id ?? 'new'}
              appointmentId={appointmentId}
              draft={draft}
              onSaved={refresh}
            />
          ) : null}
          <div className="space-y-4">
            {view.notes
              .filter((n) => n.status !== 'draft')
              .map((n) => (
                <NoteView key={n.id} note={n} />
              ))}
            {current && <NoteCorrection key={current.id} note={current} onSaved={refresh} />}
          </div>
        </Card>
      )}
      {c && (
        <Card>
          <h2 className="mb-3 text-base font-semibold text-text">Prescription</h2>
          <PrescriptionSection
            appointmentId={appointmentId}
            prescriptions={view.prescriptions}
            live={live}
            onSaved={refresh}
          />
        </Card>
      )}
      {live && (
        <Card>
          <h2 className="mb-3 text-base font-semibold text-text">End the consultation</h2>
          <OutcomePanel
            appointmentId={appointmentId}
            hasSignedNote={Boolean(current)}
            onSaved={refresh}
          />
        </Card>
      )}
      {c?.outcome && (
        <Alert tone={c.outcome === 'emergency_escalation' ? 'error' : 'success'}>
          Outcome recorded: {OUTCOME_LABELS[c.outcome]}
          {c.outcomeDetail?.followUpOn && ` · follow-up on ${c.outcomeDetail.followUpOn}`}
        </Alert>
      )}
    </div>
  );
}

// ── Patient ─────────────────────────────────────────────────────────

function PatientView({ view, status, appointmentId }) {
  const c = view.consultation;
  const outcome = c?.outcome;
  const waiting = status?.waitingRoom;
  const signed = view.notes.filter((n) => n.status === 'signed');
  return (
    <div className="space-y-4">
      {status?.emergencyGuidance && <EmergencyGuidance guidance={status.emergencyGuidance} />}
      {!c && view.appointment.mode === 'online' && (
        <Card>
          {waiting?.open ? (
            <p className="text-sm text-text">
              You are in the waiting room. Keep this page open — {view.appointment.doctorName} will
              start the consultation shortly.
            </p>
          ) : (
            <p className="text-sm text-text">
              The waiting room opens at{' '}
              {formatDateTime(waiting?.opensAt ?? view.appointment.startsAt)}.
            </p>
          )}
        </Card>
      )}
      {c?.status === 'live' && c.video && <VideoPanel appointmentId={appointmentId} />}
      {c?.status === 'live' && !c.video && (
        <Alert tone="info">Your consultation is in progress at the clinic.</Alert>
      )}
      {outcome === 'online_managed' && (
        <Alert tone="success" title="Consultation complete">
          Your doctor managed this consultation online.
          {c.outcomeDetail?.followUpOn && ` Suggested follow-up: ${c.outcomeDetail.followUpOn}.`}
        </Alert>
      )}
      {outcome === 'physical_visit_required' && (
        <Card>
          <h2 className="text-base font-semibold text-text">
            Your doctor would like to see you in person
          </h2>
          {c.outcomeDetail?.visitNote && (
            <p className="mt-2 text-sm text-text">{c.outcomeDetail.visitNote}</p>
          )}
          <Link
            className={`${linkButton} mt-3`}
            to={`/app/appointments/book?doctorId=${view.appointment.doctorId}&mode=in_clinic`}
          >
            Book an in-clinic visit
          </Link>
        </Card>
      )}
      {signed.length > 0 && (
        <Card>
          <h2 className="mb-3 text-base font-semibold text-text">Consultation summary</h2>
          <div className="space-y-4">
            {view.notes.map((n) => (
              <NoteView key={n.id} note={n} />
            ))}
          </div>
        </Card>
      )}
      {view.prescriptions.length > 0 && (
        <Card>
          <h2 className="mb-3 text-base font-semibold text-text">Prescriptions</h2>
          <div className="space-y-3">
            {view.prescriptions.map((rx) => (
              <PrescriptionCard key={rx.id} rx={rx} />
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

/** Consultation room for the patient side and the appointment's doctor (ADR-0025). */
export function ConsultationPage() {
  const { id } = useParams();
  const queryClient = useQueryClient();
  // Live state without clinical content (waiting room, start, outcome), polled. The full
  // (audited) view is re-read only when the consultation state changes.
  const status = useQuery({
    queryKey: ['consultation-status', id],
    queryFn: () => consultationApi.status(id),
    refetchInterval: (query) => (query.state.data?.consultation?.status === 'ended' ? false : 5000),
    retry: false,
  });
  const liveState = status.data?.consultation?.status ?? 'none';
  const view = useQuery({
    queryKey: ['consultation', id, liveState],
    queryFn: () => consultationApi.view(id),
    placeholderData: keepPreviousData,
  });
  const party = view.data?.party;
  // Patient heartbeat while the waiting room is open and the doctor has not started.
  useQuery({
    queryKey: ['waiting-room', id],
    queryFn: () => consultationApi.arrive(id),
    enabled:
      party === 'patient' && Boolean(status.data?.waitingRoom.open) && !status.data?.consultation,
    refetchInterval: 20_000,
    retry: false,
  });
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['consultation', id] });
    queryClient.invalidateQueries({ queryKey: ['consultation-status', id] });
  };
  const a = view.data?.appointment;
  return (
    <div className="space-y-6">
      <Link to="/app/appointments" className="text-sm font-medium text-primary">
        ← Appointments
      </Link>
      {view.isPending && <Skeleton className="h-32 w-full" />}
      {view.isError && <Alert tone="error">{authErrorMessage(view.error)}</Alert>}
      {a && (
        <>
          <div>
            <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold tracking-tight text-text">
              Consultation <StatusBadge status={a.status} />
              {view.data.consultation?.status === 'live' && <Badge tone="primary">Live</Badge>}
            </h1>
            <p className="mt-2 text-text-muted">
              {formatDateTime(a.startsAt)} · {MODE_LABELS[a.mode]} · {a.doctorName}
              {a.clinicName && ` · ${a.clinicName}`}
            </p>
          </div>
          {party === 'doctor' ? (
            <DoctorView
              view={view.data}
              status={status.data}
              appointmentId={id}
              refresh={refresh}
            />
          ) : (
            <PatientView view={view.data} status={status.data} appointmentId={id} />
          )}
        </>
      )}
    </div>
  );
}
