import { useState } from 'react';
import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { timelineApi } from '../../lib/domainApi.js';
import { authErrorMessage } from '../auth/errorMessages.js';
import { Alert } from '../../components/ui/Alert.jsx';
import { Badge, StatusBadge } from '../../components/ui/Badge.jsx';
import { Button } from '../../components/ui/Button.jsx';
import {
  ConsentRequiredNotice,
  EmptyState,
  LoadingState,
} from '../../components/ui/EmptyState.jsx';
import {
  BadgeCheck,
  CalendarDays,
  Download,
  FileText,
  FlaskConical,
  HeartPulse,
  History,
  Pill,
  Stethoscope,
} from 'lucide-react';

const TYPE_LABELS = {
  appointment: 'Appointments',
  document: 'Documents',
  lab_result: 'Lab values',
  prescription: 'Prescriptions',
  follow_up: 'Follow-ups',
};
const TYPE_ICONS = {
  appointment: CalendarDays,
  consultation: Stethoscope,
  document: FileText,
  lab_result: FlaskConical,
  prescription: Pill,
  follow_up: HeartPulse,
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

function TimelineIcon({ type }) {
  const Icon = TYPE_ICONS[type] ?? History;
  return (
    <span
      aria-hidden="true"
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary"
    >
      <Icon className="h-4 w-4" />
    </span>
  );
}

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
              size="sm"
              icon={TYPE_ICONS[t]}
              variant={types.includes(t) ? 'primary' : 'secondary'}
              aria-pressed={types.includes(t)}
              onClick={() => toggle(t)}
            >
              {label}
            </Button>
          ))}
        </div>
        {allowExport && (
          <Button
            variant="ghost"
            icon={Download}
            onClick={() => exporter.mutate()}
            loading={exporter.isPending}
          >
            Export (JSON)
          </Button>
        )}
      </div>
      {exporter.isError && <Alert tone="error">{authErrorMessage(exporter.error)}</Alert>}
      {timeline.isPending && <LoadingState label="Loading timeline" rows={3} />}
      {timeline.isError &&
        (timeline.error?.code === 'consent_required' ? (
          <ConsentRequiredNotice compact>
            The patient has not shared their records with you.
          </ConsentRequiredNotice>
        ) : (
          <Alert tone="error">{authErrorMessage(timeline.error)}</Alert>
        ))}
      {timeline.isSuccess && events.length === 0 && (
        <EmptyState compact icon={History} title="Nothing on the timeline yet">
          {types.length
            ? 'No entries of the selected kinds. Clear the filters to see everything.'
            : 'Appointments, uploaded documents, verified lab values, prescriptions and follow-ups appear here as they happen.'}
        </EmptyState>
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
              <div className="relative flex gap-3 rounded-xl border border-border bg-surface-raised p-3">
                <TimelineIcon type={e.type} />
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-text">
                    {e.title}
                    {e.status && e.type !== 'document' && <StatusBadge status={e.status} />}
                  </p>
                  <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-text-muted">
                    <time dateTime={e.occurredAt}>{formatWhen(e)}</time>
                    <Badge
                      tone={PROVENANCE_TONES[e.provenance]}
                      icon={e.provenance === 'doctor_verified' ? BadgeCheck : undefined}
                    >
                      {e.provenanceLabel}
                    </Badge>
                    {e.actor && <span>{e.actor}</span>}
                    {e.detail?.aiDerivedFields?.length > 0 && (
                      <Badge tone="warning">Date/issuer read by AI</Badge>
                    )}
                  </p>
                </div>
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
