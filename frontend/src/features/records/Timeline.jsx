import { useState } from 'react';
import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { timelineApi } from '../../lib/domainApi.js';
import { authErrorMessage } from '../auth/errorMessages.js';
import { Alert } from '../../components/ui/Alert.jsx';
import { Badge } from '../../components/ui/Badge.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { Skeleton } from '../../components/ui/Skeleton.jsx';

const TYPE_LABELS = {
  appointment: 'Appointments',
  document: 'Documents',
  lab_result: 'Lab values',
};
const PROVENANCE_TONES = {
  doctor_verified: 'success',
  system_recorded: 'neutral',
  patient_reported: 'primary',
  guardian_reported: 'primary',
  doctor_reported: 'primary',
  ai_extracted: 'warning',
};

const formatWhen = (e) =>
  new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    ...(e.datePrecision === 'instant' ? { hour: 'numeric', minute: '2-digit' } : {}),
  }).format(new Date(e.occurredAt));
const monthOf = (iso) =>
  new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric' }).format(new Date(iso));

/** Timeline of a patient's record, newest first. Each event shows where it came from. */
export function Timeline({ patientId, allowExport = false }) {
  const [types, setTypes] = useState([]);
  const timeline = useInfiniteQuery({
    queryKey: ['timeline', patientId, types.join(',')],
    queryFn: ({ pageParam }) => timelineApi.list(patientId, { cursor: pageParam, types }),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.meta?.nextCursor ?? undefined,
    enabled: Boolean(patientId),
    retry: false,
  });
  const exporter = useMutation({
    mutationFn: () => timelineApi.export(patientId),
    onSuccess: (body) => {
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = 'healthbridge-timeline.json';
      a.click();
      URL.revokeObjectURL(url);
    },
  });
  const events = timeline.data?.pages.flatMap((p) => p.data) ?? [];
  const toggle = (t) => setTypes((s) => (s.includes(t) ? s.filter((x) => x !== t) : [...s, t]));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter">
          {Object.entries(TYPE_LABELS).map(([t, label]) => (
            <Button
              key={t}
              variant={types.includes(t) ? 'primary' : 'secondary'}
              aria-pressed={types.includes(t)}
              onClick={() => toggle(t)}
            >
              {label}
            </Button>
          ))}
        </div>
        {allowExport && (
          <Button variant="ghost" onClick={() => exporter.mutate()} disabled={exporter.isPending}>
            Export (JSON)
          </Button>
        )}
      </div>
      {exporter.isError && <Alert tone="error">{authErrorMessage(exporter.error)}</Alert>}
      {timeline.isPending && <Skeleton className="h-24 w-full" />}
      {timeline.isError && (
        <Alert tone="error">
          {timeline.error?.code === 'consent_required'
            ? 'The patient has not shared their records with you.'
            : authErrorMessage(timeline.error)}
        </Alert>
      )}
      {timeline.isSuccess && events.length === 0 && (
        <p className="text-sm text-text-muted">Nothing on the timeline yet.</p>
      )}
      <ol className="space-y-2">
        {events.map((e, i) => {
          const month = monthOf(e.occurredAt);
          const header = i === 0 || month !== monthOf(events[i - 1].occurredAt);
          return (
            <li key={e.id}>
              {header && (
                <h3 className="mb-1 mt-4 text-xs font-semibold uppercase tracking-wide text-text-subtle">
                  {month}
                </h3>
              )}
              <div className="rounded-lg border border-border p-3">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-text">
                  {e.title}
                  {e.status && e.type !== 'document' && (
                    <Badge>{e.status.replace(/_/g, ' ')}</Badge>
                  )}
                </p>
                <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-text-muted">
                  <time dateTime={e.occurredAt}>{formatWhen(e)}</time>
                  <Badge tone={PROVENANCE_TONES[e.provenance]}>{e.provenanceLabel}</Badge>
                  {e.actor && <span>{e.actor}</span>}
                  {e.detail?.aiDerivedFields?.length > 0 && (
                    <Badge tone="warning">Date/issuer read by AI</Badge>
                  )}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
      {timeline.hasNextPage && (
        <Button
          variant="ghost"
          onClick={() => timeline.fetchNextPage()}
          disabled={timeline.isFetchingNextPage}
        >
          Show older
        </Button>
      )}
    </div>
  );
}
