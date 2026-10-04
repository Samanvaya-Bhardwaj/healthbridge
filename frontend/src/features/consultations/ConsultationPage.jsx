import { useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { BackLink } from '../../components/ui/BackLink.jsx';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MAX_PRESCRIPTION_ITEMS, MEDICATION_ROUTES } from '@healthbridge/shared';
import { consultationApi } from '../../lib/domainApi.js';
import { authErrorMessage } from '../auth/errorMessages.js';
import { Alert } from '../../components/ui/Alert.jsx';
import { Badge, StatusBadge } from '../../components/ui/Badge.jsx';
import { Button, ButtonLink } from '../../components/ui/Button.jsx';
import { TextAreaField } from '../../components/ui/Fields.jsx';
import { LoadingState } from '../../components/ui/EmptyState.jsx';
import { PageHeader } from '../../components/ui/Typography.jsx';
import { useConfirm } from '../../components/ui/useConfirm.jsx';
import { ArrowLeft, Building2, FileSignature, PenLine, Video } from 'lucide-react';
import { Card } from '../../components/ui/Card.jsx';
import { Skeleton } from '../../components/ui/Skeleton.jsx';
import { TextField } from '../../components/ui/TextField.jsx';
import { SelectField } from '../../components/ui/SelectField.jsx';
import { MODE_LABELS, formatDateTime } from '../appointments/format.js';
import { PrescriptionList } from './Prescriptions.jsx';
import { PatientAppointment } from './PatientAppointment.jsx';
import { EmergencyGuidance, ErrorAlert, NoteView, VideoPanel } from './ConsultationParts.jsx';
import { SOAP } from './soap.js';

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
function TextArea({ label, hint, value, onChange, rows = 3, maxLength = 4000 }) {
  return (
    <TextAreaField
      label={label}
      hint={hint}
      rows={rows}
      maxLength={maxLength}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
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
  const { confirm, dialog } = useConfirm();
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
          icon={PenLine}
          disabled={empty}
          loading={sign.isPending}
          onClick={async () => {
            const ok = await confirm({
              title: 'Sign this clinical note?',
              description:
                'Signed notes become part of the patient’s record and cannot be edited, only corrected with a reason (as a new version).',
              confirmLabel: 'Sign note',
            });
            if (ok) sign.mutate();
          }}
        >
          Sign note
        </Button>
      </div>
      {dialog}
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
  const { confirm, dialog } = useConfirm();
  const correct = useMutation({
    mutationFn: (body) => consultationApi.correctPrescription(current.id, body),
    onSuccess: () => {
      setCorrecting(false);
      onSaved();
    },
  });
  return (
    <div className="space-y-4">
      <PrescriptionList prescriptions={prescriptions.filter((p) => p.status !== 'draft')} />
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
                icon={FileSignature}
                loading={sign.isPending}
                onClick={async () => {
                  const ok = await confirm({
                    title: 'Sign this prescription?',
                    description:
                      'Signing seals the prescription and makes it available to the patient as a PDF. It cannot be edited afterwards, only corrected as a new version.',
                    confirmLabel: 'Sign prescription',
                  });
                  if (ok) sign.mutate(draft.id);
                }}
              >
                Sign prescription
              </Button>
              {dialog}
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

/**
 * One appointment (ADR-0025). The patient side gets the full appointment page (state,
 * payment, sharing, waiting room, summary); the appointment's doctor gets the
 * consultation room.
 */
export function ConsultationPage() {
  const { id } = useParams();
  const location = useLocation();
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
  if (party === 'patient') {
    return (
      <div className="space-y-6">
        <BackLink to="/app/appointments">Appointments</BackLink>
        <PatientAppointment
          view={view.data}
          status={status.data}
          appointmentId={id}
          notice={location.state?.notice}
        />
      </div>
    );
  }
  return (
    <div className="space-y-6">
      <BackLink to="/app/appointments">{party === 'doctor' ? 'Schedule' : 'Appointments'}</BackLink>
      {view.isPending && <LoadingState label="Loading appointment" rows={3} />}
      {view.isError && <Alert tone="error">{authErrorMessage(view.error)}</Alert>}
      {a && (
        <>
          <PageHeader
            icon={a.mode === 'online' ? Video : Building2}
            eyebrow="Clinical work"
            title="Consultation"
            description={`${formatDateTime(a.startsAt)} · ${MODE_LABELS[a.mode]} · ${a.doctorName}${
              a.clinicName ? ` · ${a.clinicName}` : ''
            }`}
          >
            <div className="mt-2 flex flex-wrap gap-2">
              <StatusBadge status={a.status} />
              {view.data.consultation?.status === 'live' && <StatusBadge status="live" />}
            </div>
          </PageHeader>
          <DoctorView view={view.data} status={status.data} appointmentId={id} refresh={refresh} />
        </>
      )}
    </div>
  );
}
