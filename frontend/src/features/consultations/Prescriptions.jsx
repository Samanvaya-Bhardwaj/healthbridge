import { useMutation, useQuery } from '@tanstack/react-query';
import { consultationApi } from '../../lib/domainApi.js';
import { authErrorMessage } from '../auth/errorMessages.js';
import { Button } from '../../components/ui/Button.jsx';
import { StatusBadge } from '../../components/ui/Badge.jsx';
import { Skeleton } from '../../components/ui/Skeleton.jsx';
import { formatDateTime } from '../appointments/format.js';

/** One signed (or superseded) prescription version with its PDF download. */
export function PrescriptionCard({ rx }) {
  const download = useMutation({
    mutationFn: () => consultationApi.pdfUrl(rx.id),
    onSuccess: ({ url }) => window.location.assign(url),
  });
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-text">
          {rx.reference} · v{rx.version} <StatusBadge status={rx.status} />
          {rx.doctorName && (
            <span className="font-normal text-text-muted">
              {rx.doctorName}
              {rx.signedAt && ` · ${formatDateTime(rx.signedAt)}`}
            </span>
          )}
        </p>
        {['signed', 'superseded'].includes(rx.status) && (
          <Button
            variant="secondary"
            onClick={() => download.mutate()}
            disabled={download.isPending || !rx.pdfReady}
          >
            {rx.pdfReady ? 'Download PDF' : 'PDF being prepared'}
          </Button>
        )}
      </div>
      {rx.correctionReason && (
        <p className="mt-1 text-xs text-text-muted">Correction: {rx.correctionReason}</p>
      )}
      <ol className="mt-3 space-y-1 text-sm text-text">
        {rx.items.map((i) => (
          <li key={i.position}>
            <span className="font-medium">
              {i.position}. {i.drugName}
              {i.strength && ` ${i.strength}`}
              {i.form && ` (${i.form})`}
            </span>{' '}
            — {i.dose}, {i.frequency}, {i.route}, for {i.duration}
            {i.instructions && <span className="block text-text-muted">{i.instructions}</span>}
          </li>
        ))}
      </ol>
      {rx.advice && <p className="mt-2 text-sm text-text-muted">Advice: {rx.advice}</p>}
      {download.isError && (
        <p className="mt-2 text-sm text-danger">{authErrorMessage(download.error)}</p>
      )}
    </div>
  );
}

/** Signed prescriptions of a patient (patient side, or a doctor whose consent covers them). */
export function PatientPrescriptions({ patientId }) {
  const list = useQuery({
    queryKey: ['prescriptions', patientId],
    queryFn: () => consultationApi.forPatient(patientId),
    enabled: Boolean(patientId),
    retry: false,
  });
  if (list.isPending) return <Skeleton className="h-16 w-full" />;
  if (list.isError) {
    return (
      <p className="text-sm text-text-muted">
        {list.error?.code === 'consent_required'
          ? 'The patient has not shared prescriptions with you.'
          : authErrorMessage(list.error)}
      </p>
    );
  }
  if (!list.data.length) return <p className="text-sm text-text-muted">No prescriptions yet.</p>;
  return (
    <div className="space-y-3">
      {list.data.map((rx) => (
        <PrescriptionCard key={rx.id} rx={rx} />
      ))}
    </div>
  );
}
