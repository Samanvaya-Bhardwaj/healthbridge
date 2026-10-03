import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { CalendarDays, Download, FileSignature, Pill } from 'lucide-react';
import { consultationApi } from '../../lib/domainApi.js';
import { authErrorMessage } from '../auth/errorMessages.js';
import { Button, ButtonLink } from '../../components/ui/Button.jsx';
import { StatusBadge } from '../../components/ui/Badge.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import {
  ConsentRequiredNotice,
  EmptyState,
  LoadingState,
} from '../../components/ui/EmptyState.jsx';
import { formatDateTime } from '../appointments/format.js';

/** One signed (or replaced) prescription version, presented like a prescription slip. */
export function PrescriptionCard({ rx }) {
  const download = useMutation({
    mutationFn: () => consultationApi.pdfUrl(rx.id),
    onSuccess: ({ url }) => window.location.assign(url),
  });
  return (
    <article className="rounded-xl border border-border bg-surface-raised">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-start gap-3">
          <span
            aria-hidden="true"
            className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary"
          >
            <FileSignature className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-text">
              Prescription {rx.reference} · version {rx.version}
              <StatusBadge status={rx.status} />
            </p>
            {rx.doctorName && (
              <p className="text-sm text-text-muted">
                {rx.doctorName}
                {rx.signedAt && ` · signed ${formatDateTime(rx.signedAt)}`}
              </p>
            )}
          </div>
        </div>
        {['signed', 'superseded'].includes(rx.status) && (
          <Button
            variant="secondary"
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
          <p className="mb-2 text-xs text-text-muted">Correction: {rx.correctionReason}</p>
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
  return (
    <div className="space-y-3">
      {list.data.map((rx) => (
        <PrescriptionCard key={rx.id} rx={rx} />
      ))}
    </div>
  );
}
