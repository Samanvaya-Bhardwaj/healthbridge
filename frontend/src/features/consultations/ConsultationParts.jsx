import { useMutation } from '@tanstack/react-query';
import { consultationApi } from '../../lib/domainApi.js';
import { authErrorMessage } from '../auth/errorMessages.js';
import { Alert } from '../../components/ui/Alert.jsx';
import { StatusBadge } from '../../components/ui/Badge.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { formatDateTime } from '../appointments/format.js';
import { VideoRoom } from './VideoRoom.jsx';
import { PATIENT_SOAP_LABELS, SOAP } from './soap.js';

/** Pieces of the consultation room shared by the doctor and patient views. */

export function ErrorAlert({ error }) {
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

export function EmergencyGuidance({ guidance }) {
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

export function NoteView({ note, patient = false }) {
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
            <dt className="text-xs font-semibold uppercase text-text-subtle">
              {patient ? PATIENT_SOAP_LABELS[key] : label}
            </dt>
            <dd className="whitespace-pre-wrap text-sm text-text">{note.note[key]}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function VideoPanel({ appointmentId }) {
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
