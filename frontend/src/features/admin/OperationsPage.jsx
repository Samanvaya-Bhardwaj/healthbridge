import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { adminApi } from '../../lib/domainApi.js';
import { authErrorMessage } from '../auth/errorMessages.js';
import { Card } from '../../components/ui/Card.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { Badge } from '../../components/ui/Badge.jsx';
import { Skeleton } from '../../components/ui/Skeleton.jsx';
import { EmptyState } from '../../components/ui/EmptyState.jsx';
import { PageHeader } from '../../components/ui/Typography.jsx';
import { ServerCog } from 'lucide-react';

const QUEUE_STATES = ['waiting', 'active', 'delayed', 'failed'];

function Counts({ title, counts }) {
  const entries = Object.entries(counts ?? {});
  return (
    <Card>
      <h2 className="text-sm font-semibold text-text">{title}</h2>
      {entries.length === 0 ? (
        <p className="mt-2 text-sm text-text-muted">None.</p>
      ) : (
        <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
          {entries.map(([status, n]) => (
            <div key={status}>
              <dt className="text-xs text-text-subtle">{status}</dt>
              <dd className="text-xl font-semibold tabular-nums text-text">{n}</dd>
            </div>
          ))}
        </dl>
      )}
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
  const summary = useQuery({
    queryKey: ['admin', 'operations', 'summary'],
    queryFn: adminApi.operationsSummary,
    refetchInterval: 15_000,
  });
  const deadLetters = useQuery({
    queryKey: ['admin', 'operations', 'dead-letters'],
    queryFn: () => adminApi.deadLetters('open'),
  });
  const retry = useMutation({
    mutationFn: (id) => adminApi.retryDeadLetter(id),
    onSuccess: () => {
      setMessage({ tone: 'success', text: 'Job queued again.' });
      queryClient.invalidateQueries({ queryKey: ['admin', 'operations'] });
    },
    onError: (error) => setMessage({ tone: 'error', text: authErrorMessage(error) }),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        icon={ServerCog}
        eyebrow="Oversight"
        title="Operations"
        description="Background jobs: notifications, payments, documents and follow-ups. Retry jobs that failed after all automatic attempts; every retry is audited."
      />

      {summary.isPending ? (
        <Skeleton className="h-32" />
      ) : summary.isError ? (
        <Alert tone="error">{authErrorMessage(summary.error)}</Alert>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            <Counts title="Outbox events" counts={summary.data.outbox} />
            <Counts title="Dead letters" counts={summary.data.deadLetters} />
          </div>
          {summary.data.queues ? (
            <div className="relative overflow-x-auto rounded-2xl border border-border bg-surface-raised">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Queues</caption>
                <thead className="border-b border-border text-text-subtle">
                  <tr>
                    <th scope="col" className="px-4 py-3 font-medium">
                      Queue
                    </th>
                    {QUEUE_STATES.map((s) => (
                      <th key={s} scope="col" className="px-4 py-3 text-right font-medium">
                        {s}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {Object.entries(summary.data.queues).map(([name, counts]) => (
                    <tr key={name}>
                      <th scope="row" className="px-4 py-3 font-mono text-xs font-normal">
                        {name}
                      </th>
                      {QUEUE_STATES.map((s) => (
                        <td key={s} className="px-4 py-3 text-right tabular-nums">
                          {counts[s] ?? 0}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Alert tone="warning">
              The job queue is unreachable. Events wait safely in the outbox and are relayed when it
              returns.
            </Alert>
          )}
        </>
      )}

      <section className="space-y-3" aria-labelledby="dead-letters-heading">
        <h2 id="dead-letters-heading" className="text-lg font-semibold text-text">
          Jobs that need attention
        </h2>
        {message && <Alert tone={message.tone}>{message.text}</Alert>}
        {deadLetters.isPending ? (
          <Skeleton className="h-24" />
        ) : deadLetters.isError ? (
          <Alert tone="error">{authErrorMessage(deadLetters.error)}</Alert>
        ) : deadLetters.data.length === 0 ? (
          <EmptyState title="Nothing needs attention">
            Every job has completed or is retrying.
          </EmptyState>
        ) : (
          <ul className="space-y-3">
            {deadLetters.data.map((d) => (
              <li key={d.id}>
                <Card>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-mono text-sm text-text">
                        {d.queue} · {d.jobName}
                      </p>
                      <p className="mt-1 text-xs text-text-subtle">
                        {d.attempts} attempt(s) · last failed{' '}
                        {new Date(d.failedAt).toLocaleString('en-IN')}
                        {d.aggregateType && ` · ${d.aggregateType}`}
                      </p>
                      <p className="mt-2 break-words text-sm text-text-muted">{d.failureReason}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge tone="danger">open</Badge>
                      <Button
                        variant="secondary"
                        disabled={retry.isPending}
                        onClick={() => retry.mutate(d.id)}
                      >
                        Retry
                      </Button>
                    </div>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
