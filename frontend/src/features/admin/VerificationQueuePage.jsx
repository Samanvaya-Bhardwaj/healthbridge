import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { VERIFICATION_REASON_CODES } from '@healthbridge/shared';
import { adminApi } from '../../lib/domainApi.js';
import { authErrorMessage } from '../auth/errorMessages.js';
import { Card } from '../../components/ui/Card.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { StatusBadge } from '../../components/ui/Badge.jsx';
import { Skeleton } from '../../components/ui/Skeleton.jsx';
import { BadgeCheck } from 'lucide-react';
import { PageHeader } from '../../components/ui/Typography.jsx';
import { EmptyState } from '../../components/ui/EmptyState.jsx';
import { controlClass } from '../../components/ui/fieldStyles.js';

const REJECTION_REASONS = VERIFICATION_REASON_CODES.filter((c) => c !== 'credentials_confirmed');
const humanize = (code) => code.replace(/_/g, ' ');

function Decision({ item, onDone }) {
  const [reasonCode, setReasonCode] = useState(REJECTION_REASONS[0]);
  const [notes, setNotes] = useState('');
  const decide = useMutation({
    mutationFn: (decision) =>
      adminApi.decide(item.id, {
        decision,
        reasonCode: decision === 'verified' ? 'credentials_confirmed' : reasonCode,
        ...(notes ? { notes } : {}),
      }),
    onSuccess: onDone,
  });
  return (
    <div className="mt-4 space-y-3 rounded-lg border border-border p-4">
      <label className="block text-sm font-medium text-text" htmlFor={`notes-${item.id}`}>
        Internal notes (not shown to the doctor)
      </label>
      <textarea
        id={`notes-${item.id}`}
        rows={2}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        className={controlClass(false, { inline: true })}
      />
      <div className="flex flex-wrap items-end gap-2">
        <Button onClick={() => decide.mutate('verified')} disabled={decide.isPending}>
          Approve
        </Button>
        <label className="sr-only" htmlFor={`reason-${item.id}`}>
          Rejection reason
        </label>
        <select
          id={`reason-${item.id}`}
          value={reasonCode}
          onChange={(e) => setReasonCode(e.target.value)}
          className={controlClass(false, { inline: true })}
        >
          {REJECTION_REASONS.map((r) => (
            <option key={r} value={r}>
              {humanize(r)}
            </option>
          ))}
        </select>
        <Button
          variant="secondary"
          onClick={() => decide.mutate('rejected')}
          disabled={decide.isPending}
        >
          Reject
        </Button>
      </div>
      {decide.isError && <Alert tone="error">{authErrorMessage(decide.error)}</Alert>}
    </div>
  );
}

/** Platform admin: doctor credential-verification queue (manual review in M2). */
export function VerificationQueuePage() {
  const queryClient = useQueryClient();
  const queue = useQuery({
    queryKey: ['admin', 'verifications'],
    queryFn: () => adminApi.verificationQueue(),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin', 'verifications'] });
  const start = useMutation({ mutationFn: adminApi.startReview, onSuccess: refresh });

  return (
    <div className="space-y-6">
      <PageHeader
        icon={BadgeCheck}
        eyebrow="Administration"
        title="Doctor verification"
        description="Check each registration against the medical council register before approving. Only verified doctors appear to patients. Every decision is audited."
      />
      {start.isError && <Alert tone="error">{authErrorMessage(start.error)}</Alert>}
      {queue.isPending && <Skeleton className="h-24 w-full" />}
      {queue.data?.length === 0 && (
        <EmptyState icon={BadgeCheck} title="No doctors waiting for verification">
          New applications appear here when doctors submit their profile.
        </EmptyState>
      )}
      {queue.data?.map((item) => (
        <Card key={item.id}>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="flex items-center gap-2 font-medium text-text">
                {item.doctor?.professionalName} <StatusBadge status={item.status} />
              </p>
              <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm text-text-muted sm:grid-cols-2">
                <div>
                  <dt className="inline">Registration: </dt>
                  <dd className="inline font-medium text-text">{item.registrationNumber}</dd>
                </div>
                <div>
                  <dt className="inline">Council: </dt>
                  <dd className="inline">
                    {item.registrationCouncil} ({item.registrationYear})
                  </dd>
                </div>
                <div>
                  <dt className="inline">Specialization: </dt>
                  <dd className="inline">{item.doctor?.primarySpecialization}</dd>
                </div>
                <div>
                  <dt className="inline">Submitted: </dt>
                  <dd className="inline">{new Date(item.submittedAt).toLocaleString('en-IN')}</dd>
                </div>
              </dl>
            </div>
            {item.status === 'pending' && (
              <Button onClick={() => start.mutate(item.id)} disabled={start.isPending}>
                Start review
              </Button>
            )}
          </div>
          {item.status === 'under_review' && <Decision item={item} onDone={refresh} />}
        </Card>
      ))}
    </div>
  );
}
