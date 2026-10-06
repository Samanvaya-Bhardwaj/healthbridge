import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, RotateCcw, ServerCog } from 'lucide-react';
import { adminApi } from '../../lib/domainApi.js';
import { authErrorMessage } from '../auth/errorMessages.js';
import { Card } from '../../components/ui/Card.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { Badge } from '../../components/ui/Badge.jsx';
import { EmptyState, LoadingState } from '../../components/ui/EmptyState.jsx';
import { PageHeader, SectionHeader } from '../../components/ui/Typography.jsx';
import { Tabs } from '../../components/ui/Tabs.jsx';
import { ActionDialog, PlatformBoundary } from './AdminParts.jsx';
import { QUEUE_NAMES, platformHealth } from './adminHealth.js';
import { useSafeMutation } from '../../lib/useSafeMutation.js';

/** Job states in plain words, the same everywhere on this page. */
const STATES = [
  ['waiting', 'Pending', 'neutral', 'Queued, about to run.'],
  ['active', 'Processing', 'primary', 'Running now.'],
  [
    'delayed',
    'Scheduled or retrying',
    'info',
    'Waiting for a set time: a scheduled task or an automatic retry.',
  ],
  ['failed', 'Failed', 'warning', 'Failed its last attempt in the queue.'],
];
const DEAD_TABS = [
  ['open', 'Needs action'],
  ['retried', 'Retried'],
  ['resolved', 'Resolved'],
];

function DeadLetter({ d, onRetry, pending }) {
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-text">{QUEUE_NAMES[d.queue] ?? d.queue}</p>
          <p className="font-mono text-xs text-text-muted">{d.jobName}</p>
          <p className="mt-1 text-xs text-text-subtle">
            {d.attempts} attempt{d.attempts === 1 ? '' : 's'} · first failed{' '}
            {new Date(d.firstFailedAt ?? d.failedAt).toLocaleString('en-IN')} · last failed{' '}
            {new Date(d.failedAt).toLocaleString('en-IN')}
            {d.retriedAt && ` · retried ${new Date(d.retriedAt).toLocaleString('en-IN')}`}
          </p>
          <p className="mt-2 break-words rounded-lg bg-surface-muted px-3 py-2 font-mono text-xs text-text">
            {d.failureReason}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={d.status === 'open' ? 'danger' : 'neutral'}>
            {d.status === 'open' ? 'Dead letter' : d.status === 'retried' ? 'Retried' : 'Resolved'}
          </Badge>
          {d.status === 'open' && (
            <Button
              variant="secondary"
              icon={RotateCcw}
              disabled={pending}
              onClick={() => onRetry(d)}
            >
              Retry
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

/**
 * Platform admin (operations:manage): background-job health and dead letters. Shows
 * identifiers, counts and failure reasons only. Retrying is audited; consumers are
 * idempotent, so a retry never repeats an effect that already happened.
 */
export function OperationsPage() {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState(null);
  const [tab, setTab] = useState('open');
  const [confirming, setConfirming] = useState(null);
  const summary = useQuery({
    queryKey: ['admin', 'operations', 'summary'],
    queryFn: adminApi.operationsSummary,
    refetchInterval: 15_000,
  });
  const deadLetters = useQuery({
    queryKey: ['admin', 'operations', 'dead-letters', tab],
    queryFn: () => adminApi.deadLetters(tab),
  });
  const retry = useSafeMutation({
    mutationFn: (id) => adminApi.retryDeadLetter(id),
    onSuccess: () => {
      setConfirming(null);
      setMessage({ tone: 'success', text: 'Job queued again.' });
      queryClient.invalidateQueries({ queryKey: ['admin', 'operations'] });
    },
  });
  const openDead = summary.data?.deadLetters?.open ?? 0;
  const status = summary.data && platformHealth(summary.data);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={ServerCog}
        eyebrow="Oversight"
        title="Operations"
        description="Background jobs: notifications, payments, documents, reminders and follow-ups. Most failures are retried automatically; only jobs that gave up need you."
      />
      <PlatformBoundary compact />

      {summary.isPending && <LoadingState label="Loading job health" rows={2} />}
      {summary.isError && <Alert tone="error">{authErrorMessage(summary.error)}</Alert>}
      {status && (
        <Alert tone={status.tone} title={status.title}>
          {status.text}
        </Alert>
      )}

      {summary.data && (
        <>
          <Card>
            <SectionHeader
              title="What the states mean"
              description="Counts refresh every 15 seconds."
            />
            <ul className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
              <li className="flex items-start gap-2">
                <Badge tone="success">Healthy</Badge>
                <span className="text-text-muted">Nothing waiting or failing.</span>
              </li>
              {STATES.map(([key, label, tone, help]) => (
                <li key={key} className="flex items-start gap-2">
                  <Badge tone={tone}>{label}</Badge>
                  <span className="text-text-muted">{help}</span>
                </li>
              ))}
              <li className="flex items-start gap-2">
                <Badge tone="danger">Dead letter</Badge>
                <span className="text-text-muted">
                  Failed all automatic attempts; waits below until someone retries it.
                </span>
              </li>
            </ul>
          </Card>

          {summary.data.queues && (
            <div
              role="region"
              aria-label="Queues table"
              tabIndex={0}
              className="relative overflow-x-auto rounded-2xl border border-border bg-surface-raised"
            >
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Queues</caption>
                <thead className="border-b border-border text-text-subtle">
                  <tr>
                    <th scope="col" className="px-4 py-3 font-medium">
                      Queue
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      Health
                    </th>
                    {STATES.map(([key, label]) => (
                      <th key={key} scope="col" className="px-4 py-3 text-right font-medium">
                        {label}
                      </th>
                    ))}
                    <th scope="col" className="px-4 py-3 text-right font-medium">
                      Completed
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {Object.entries(summary.data.queues).map(([name, counts]) => {
                    const state = counts.failed
                      ? ['warning', 'Failing']
                      : counts.waiting || counts.active
                        ? ['primary', 'Busy']
                        : ['success', 'Healthy'];
                    return (
                      <tr key={name}>
                        <th scope="row" className="px-4 py-3 font-normal">
                          <span className="block font-mono text-xs">{name}</span>
                          <span className="block text-xs text-text-subtle">
                            {QUEUE_NAMES[name] ?? ''}
                          </span>
                        </th>
                        <td className="px-4 py-3">
                          <Badge tone={state[0]}>{state[1]}</Badge>
                        </td>
                        {STATES.map(([key]) => (
                          <td key={key} className="px-4 py-3 text-right tabular-nums">
                            {counts[key] ?? 0}
                          </td>
                        ))}
                        <td className="px-4 py-3 text-right tabular-nums text-text-muted">
                          {counts.completed ?? 0}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <Card>
            <SectionHeader
              title="Outbox events"
              description="Events written with each change, then relayed to the job queue."
            />
            <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-2">
              {[
                ['pending', 'Waiting to relay'],
                ['dispatched', 'Relayed'],
                ['failed', 'Failed to relay'],
              ].map(([key, label]) => (
                <div key={key}>
                  <dt className="text-xs text-text-subtle">{label}</dt>
                  <dd
                    className={`text-xl font-semibold tabular-nums ${
                      key === 'failed' && summary.data.outbox?.failed ? 'text-danger' : 'text-text'
                    }`}
                  >
                    {summary.data.outbox?.[key] ?? 0}
                  </dd>
                </div>
              ))}
            </dl>
          </Card>
        </>
      )}

      <section className="space-y-3" aria-labelledby="dead-letters-heading">
        <h2 id="dead-letters-heading" className="text-lg font-semibold text-text">
          Jobs that need attention
        </h2>
        <Tabs
          label="Dead letters"
          value={tab}
          onChange={(t) => {
            setTab(t);
            setMessage(null);
          }}
          tabs={DEAD_TABS.map(([key, label]) => [
            key,
            key === 'open' && openDead ? `${label} (${openDead})` : label,
          ])}
        />
        {message && <Alert tone={message.tone}>{message.text}</Alert>}
        {deadLetters.isPending ? (
          <LoadingState label="Loading jobs" rows={2} />
        ) : deadLetters.isError ? (
          <Alert tone="error">{authErrorMessage(deadLetters.error)}</Alert>
        ) : deadLetters.data.length === 0 ? (
          <EmptyState compact icon={CheckCircle2} title="Nothing here">
            {tab === 'open'
              ? 'No job needs action. Every job has completed or is still retrying automatically.'
              : 'No jobs in this group.'}
          </EmptyState>
        ) : (
          <ul className="space-y-3">
            {deadLetters.data.map((d) => (
              <li key={d.id}>
                <DeadLetter d={d} onRetry={setConfirming} pending={retry.isPending} />
              </li>
            ))}
          </ul>
        )}
      </section>
      {confirming && (
        <ActionDialog
          title="Run this job again?"
          description={`${QUEUE_NAMES[confirming.queue] ?? confirming.queue}: ${confirming.jobName}. It runs once more with the same input. Jobs are safe to repeat: anything that already happened is not done twice. Fix the cause first (see the failure reason), or it will fail again. The retry is recorded in the audit log.`}
          confirmLabel="Retry job"
          pending={retry.isPending}
          error={retry.error}
          onConfirm={() => retry.mutate(confirming.id)}
          onClose={() => setConfirming(null)}
        />
      )}
    </div>
  );
}
