import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
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
  Info,
  Pill,
  Sparkles,
  Stethoscope,
  UserRound,
} from 'lucide-react';
import { useSafeMutation } from '../../lib/useSafeMutation.js';

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
/** Where an entry came from: one tone and icon per kind, so it never relies on colour. */
const PROVENANCE = {
  patient_reported: { tone: 'info', icon: UserRound },
  guardian_reported: { tone: 'info', icon: UserRound },
  doctor_reported: { tone: 'primary', icon: Stethoscope },
  doctor_verified: { tone: 'success', icon: BadgeCheck },
  system_recorded: { tone: 'neutral', icon: Info },
  ai_extracted: { tone: 'ai', icon: Sparkles },
};
const LEGEND = [
  [
    'patient_reported',
    'Patient reported',
    'Added by you (or a guardian). Not checked by a doctor.',
  ],
  ['doctor_reported', 'Doctor reported', 'Written or added by one of your doctors.'],
  ['doctor_verified', 'Verified', 'Checked by a doctor against the original document.'],
];

function ProvenanceLegend() {
  return (
    <details className="rounded-xl border border-border px-4 py-3">
      <summary className="cursor-pointer text-sm font-medium text-primary">
        What the labels mean
      </summary>
      <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
        {LEGEND.map(([key, title, text]) => (
          <li key={key} className="text-sm">
            <Badge tone={PROVENANCE[key].tone} icon={PROVENANCE[key].icon}>
              {title}
            </Badge>
            <p className="mt-1 text-text-muted">{text}</p>
          </li>
        ))}
      </ul>
    </details>
  );
}

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
      className="relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary ring-4 ring-surface-raised"
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
  const exporter = useSafeMutation({
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
            Download a copy
          </Button>
        )}
      </div>
      <ProvenanceLegend />
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
      <ol className="relative">
        {events.map((e, i) => {
          const month = monthOf(e.occurredAt);
          const header = i === 0 || month !== monthOf(events[i - 1].occurredAt);
          const p = PROVENANCE[e.provenance] ?? PROVENANCE.system_recorded;
          return (
            <li key={e.id}>
              {header && (
                <h3 className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wide text-text-subtle first:mt-0">
                  {month}
                </h3>
              )}
              <div className="relative flex gap-3 pb-4">
                {/* the rail */}
                <span
                  aria-hidden="true"
                  className="absolute bottom-0 left-4 top-8 w-px bg-border"
                />
                <TimelineIcon type={e.type} />
                <div
                  className={`min-w-0 flex-1 rounded-xl border bg-surface-raised p-3 ${
                    e.provenance === 'doctor_verified' ? 'border-success/40' : 'border-border'
                  }`}
                >
                  <p className="text-xs text-text-muted">
                    <time dateTime={e.occurredAt}>{formatWhen(e)}</time>
                  </p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-2 text-sm font-medium text-text">
                    {e.title}
                    {e.status && e.type !== 'document' && <StatusBadge status={e.status} />}
                  </p>
                  <p className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-text-muted">
                    <Badge tone={p.tone} icon={p.icon}>
                      {e.provenanceLabel}
                    </Badge>
                    {e.actor && <span>{e.actor}</span>}
                    {e.detail?.aiDerivedFields?.length > 0 && (
                      <Badge tone="ai" icon={Sparkles}>
                        Date/issuer read by AI
                      </Badge>
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
