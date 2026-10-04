import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { CalendarDays, Download, FilePen, FileSignature, History, Pill } from 'lucide-react';
import { consultationApi } from '../../lib/domainApi.js';
import { authErrorMessage } from '../auth/errorMessages.js';
import { Button, ButtonLink } from '../../components/ui/Button.jsx';
import { Badge } from '../../components/ui/Badge.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import {
  ConsentRequiredNotice,
  EmptyState,
  LoadingState,
} from '../../components/ui/EmptyState.jsx';
import { formatDateTime } from '../appointments/format.js';

/**
 * How each prescription state looks. A signed prescription is the authoritative,
 * downloadable document; a draft is visibly not valid yet; a replaced version is
 * de-emphasised and points to its correction.
 */
const LOOK = {
  signed: {
    card: 'border-2 border-success/50 bg-surface-raised',
    header: 'bg-success/10',
    icon: FileSignature,
    iconClass: 'bg-success text-white',
    badge: ['success', 'Signed · valid'],
  },
  draft: {
    card: 'border-2 border-dashed border-warning/60 bg-surface-raised',
    header: 'bg-warning/10',
    icon: FilePen,
    iconClass: 'bg-warning/20 text-warning',
    badge: ['warning', 'Draft · not valid until signed'],
  },
  superseded: {
    card: 'border border-border bg-surface-muted',
    header: '',
    icon: History,
    iconClass: 'bg-surface-raised text-text-subtle',
    badge: ['neutral', 'Replaced by a correction'],
  },
};

/** One prescription version, presented like a prescription slip. */
export function PrescriptionCard({ rx }) {
  const look = LOOK[rx.status] ?? LOOK.superseded;
  const Icon = look.icon;
  const download = useMutation({
    mutationFn: () => consultationApi.pdfUrl(rx.id),
    onSuccess: ({ url }) => window.location.assign(url),
  });
  return (
    <article className={`overflow-hidden rounded-xl ${look.card}`}>
      <header
        className={`flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3 ${look.header}`}
      >
        <div className="flex min-w-0 items-start gap-3">
          <span
            aria-hidden="true"
            className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${look.iconClass}`}
          >
            <Icon className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-text">
              Prescription {rx.reference}
              <Badge tone={look.badge[0]}>{look.badge[1]}</Badge>
            </p>
            <p className="text-sm text-text-muted">
              {rx.doctorName && `${rx.doctorName} · `}
              {rx.signedAt ? `Signed ${formatDateTime(rx.signedAt)}` : 'Not signed yet'}
              {rx.version > 1 && ` · Version ${rx.version}`}
            </p>
          </div>
        </div>
        {['signed', 'superseded'].includes(rx.status) && (
          <Button
            variant={rx.status === 'signed' ? 'primary' : 'secondary'}
            size="sm"
            icon={Download}
            onClick={() => download.mutate()}
            loading={download.isPending}
            disabled={!rx.pdfReady}
          >
            {rx.pdfReady ? 'Download PDF' : 'PDF being prepared'}
          </Button>
        )}
      </header>
      <div className="px-4 py-3">
        {rx.correctionReason && (
          <p className="mb-3 rounded-lg bg-surface-muted px-3 py-2 text-sm text-text">
            <span className="font-medium">Corrected:</span> {rx.correctionReason}
          </p>
        )}
        <ol className="space-y-2 text-sm text-text">
          {rx.items.map((i) => (
            <li key={i.position} className="flex gap-2">
              <Pill aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-text-subtle" />
              <span>
                <span className="font-medium">
                  {i.drugName}
                  {i.strength && ` ${i.strength}`}
                  {i.form && ` (${i.form})`}
                </span>{' '}
                — {i.dose}, {i.frequency}, {i.route}, for {i.duration}
                {i.instructions && <span className="block text-text-muted">{i.instructions}</span>}
              </span>
            </li>
          ))}
        </ol>
        {rx.advice && <p className="mt-3 text-sm text-text-muted">Advice: {rx.advice}</p>}
        {download.isError && (
          <Alert tone="error" className="mt-3">
            {authErrorMessage(download.error)}
          </Alert>
        )}
      </div>
    </article>
  );
}

/**
 * Prescriptions grouped by reference: the current version first and prominent, replaced
 * versions folded underneath it.
 */
export function PrescriptionList({ prescriptions }) {
  const groups = new Map();
  for (const rx of prescriptions) {
    if (!groups.has(rx.reference)) groups.set(rx.reference, []);
    groups.get(rx.reference).push(rx);
  }
  return (
    <div className="space-y-4">
      {[...groups.entries()].map(([reference, versions]) => {
        const [current, ...older] = [...versions].sort((a, b) => b.version - a.version);
        return (
          <div key={reference}>
            <PrescriptionCard rx={current} />
            {older.length > 0 && (
              <details className="mt-2 pl-4">
                <summary className="cursor-pointer text-sm text-text-muted">
                  Earlier version{older.length === 1 ? '' : 's'} ({older.length})
                </summary>
                <div className="mt-2 space-y-2">
                  {older.map((rx) => (
                    <PrescriptionCard key={rx.id} rx={rx} />
                  ))}
                </div>
              </details>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Signed prescriptions of a patient: the patient side, or a doctor whose consent covers
 * them. `audience` shapes the empty and no-consent messages.
 */
export function PatientPrescriptions({ patientId, audience = 'patient' }) {
  const list = useQuery({
    queryKey: ['prescriptions', patientId],
    queryFn: () => consultationApi.forPatient(patientId),
    enabled: Boolean(patientId),
    retry: false,
  });
  if (list.isPending) return <LoadingState label="Loading prescriptions" rows={2} />;
  if (list.isError) {
    return list.error?.code === 'consent_required' ? (
      <ConsentRequiredNotice compact>
        The patient has not shared prescriptions with you.
      </ConsentRequiredNotice>
    ) : (
      <Alert tone="error">{authErrorMessage(list.error)}</Alert>
    );
  }
  if (!list.data.length) {
    return audience === 'patient' ? (
      <EmptyState
        compact
        icon={Pill}
        title="No prescriptions yet"
        action={
          <ButtonLink
            as={Link}
            to="/app/appointments"
            variant="secondary"
            size="sm"
            icon={CalendarDays}
          >
            Go to appointments
          </ButtonLink>
        }
      >
        When a doctor signs a prescription during a consultation, it appears here and can be
        downloaded as a PDF.
      </EmptyState>
    ) : (
      <EmptyState compact icon={Pill} title="No prescriptions yet">
        Prescriptions you or other doctors sign for this patient appear here.
      </EmptyState>
    );
  }
  return <PrescriptionList prescriptions={list.data} />;
}
