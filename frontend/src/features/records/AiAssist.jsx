import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { assistApi } from '../../lib/domainApi.js';
import { authErrorMessage } from '../auth/errorMessages.js';
import { Alert } from '../../components/ui/Alert.jsx';
import { Badge } from '../../components/ui/Badge.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { Card } from '../../components/ui/Card.jsx';
import { Skeleton } from '../../components/ui/Skeleton.jsx';
import { TextField } from '../../components/ui/TextField.jsx';
import { PageHeader } from '../../components/ui/Typography.jsx';
import { BackLink } from '../../components/ui/BackLink.jsx';
import { RefreshCw, Sparkles } from 'lucide-react';
import { formatDateTime } from '../appointments/format.js';

const AI_NOTICE =
  'AI-generated from the shared records. Every sentence cites its source — check the sources before relying on it. It does not diagnose or recommend treatment.';

function Sentences({ sentences }) {
  return (
    <ul className="space-y-2">
      {sentences.map((s, i) => (
        <li key={i} className="text-sm text-text">
          {s.text}{' '}
          {s.citations.map((c) => (
            <span
              key={`${c.label}-${c.title}`}
              className="ml-1 inline-flex rounded bg-surface-muted px-1.5 py-0.5 text-xs text-text-muted"
              title={c.title}
            >
              {c.label} · {c.title}
            </span>
          ))}
        </li>
      ))}
    </ul>
  );
}

/** Doctor: ask a question about a consented patient's records (patient-scoped RAG). */
export function AskRecords({ patientId }) {
  const [question, setQuestion] = useState('');
  const ask = useMutation({ mutationFn: () => assistApi.ask(patientId, question.trim()) });
  return (
    <div className="space-y-3">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (question.trim().length >= 3) ask.mutate();
        }}
      >
        <TextField
          className="min-w-64 flex-1"
          label="Ask about these records"
          value={question}
          maxLength={500}
          onChange={(e) => setQuestion(e.target.value)}
          hint="For example: What was the most recent WBC count?"
        />
        <Button type="submit" disabled={ask.isPending || question.trim().length < 3}>
          {ask.isPending ? 'Searching…' : 'Ask'}
        </Button>
      </form>
      {ask.isError && (
        <Alert tone="error">
          {ask.error?.code === 'ai_processing_disabled'
            ? 'The patient has not turned on AI reading of their documents.'
            : authErrorMessage(ask.error)}
        </Alert>
      )}
      {ask.data && (
        <div className="rounded-xl border border-ai/25 bg-ai-soft/40 p-3">
          <p className="mb-2 flex items-center gap-2 text-xs text-text-muted">
            <Badge tone="ai" icon={Sparkles}>
              AI-generated
            </Badge>{' '}
            {AI_NOTICE}
          </p>
          {ask.data.status === 'answered' ? (
            <Sentences sentences={ask.data.sentences} />
          ) : (
            <p className="text-sm font-medium text-text">{ask.data.answer}</p>
          )}
        </div>
      )}
    </div>
  );
}

/** Doctor: pre-consultation brief for one of their appointments. */
export function BriefPage() {
  const { id } = useParams();
  const queryClient = useQueryClient();
  const brief = useQuery({
    queryKey: ['brief', id],
    queryFn: () => assistApi.brief(id, false),
    retry: false,
  });
  const refresh = useMutation({
    mutationFn: () => assistApi.brief(id, true),
    onSuccess: (data) => queryClient.setQueryData(['brief', id], data),
  });
  const feedback = useMutation({
    mutationFn: (rating) => assistApi.feedback(brief.data.id, rating),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['brief', id] }),
  });
  const b = brief.data;
  return (
    <div className="space-y-6">
      <BackLink to={`/app/appointments/${id}/consultation`}>Appointment</BackLink>
      <PageHeader
        icon={Sparkles}
        eyebrow="Clinical work · AI-assisted"
        title="Pre-consultation brief"
        description="A summary of the records this patient has shared with you, written by AI from verified lab values and document excerpts only. Every statement cites its source. It never diagnoses; check the sources before relying on it."
        actions={
          b && (
            <Button
              variant="secondary"
              icon={RefreshCw}
              onClick={() => refresh.mutate()}
              loading={refresh.isPending}
            >
              {refresh.isPending ? 'Refreshing…' : 'Refresh'}
            </Button>
          )
        }
      />
      {brief.isPending && <Skeleton className="h-32 w-full" />}
      {brief.isError && (
        <Alert tone="error">
          {brief.error?.code === 'consent_required'
            ? 'The patient has not shared their records with you.'
            : brief.error?.code === 'ai_processing_disabled'
              ? 'The patient has not turned on AI reading of their documents.'
              : authErrorMessage(brief.error)}
        </Alert>
      )}
      {b && (
        <Card className="border-2 border-dashed border-ai/30">
          <p className="mb-4 flex flex-wrap items-center gap-2 rounded-lg bg-ai-soft px-3 py-2 text-xs text-text">
            <Badge tone="ai" icon={Sparkles}>
              AI-generated · not a clinical opinion
            </Badge>
            {AI_NOTICE}
            {b.createdAt && ` Prepared ${formatDateTime(b.createdAt)}.`}
          </p>
          {b.sections.length === 0 ? (
            <p className="text-sm font-medium text-text">{b.message}</p>
          ) : (
            <div className="space-y-5">
              {b.sections.map((section) => (
                <section key={section.heading}>
                  <h2 className="mb-2 text-sm font-semibold text-text">{section.heading}</h2>
                  <Sentences sentences={section.sentences} />
                </section>
              ))}
            </div>
          )}
          <div className="mt-6 flex items-center gap-2 border-t border-border pt-4 text-sm text-text-muted">
            Was this brief helpful?
            {['helpful', 'not_helpful'].map((rating) => (
              <Button
                key={rating}
                variant={b.feedback?.rating === rating ? 'primary' : 'ghost'}
                aria-pressed={b.feedback?.rating === rating}
                onClick={() => feedback.mutate(rating)}
                disabled={feedback.isPending}
              >
                {rating === 'helpful' ? 'Yes' : 'No'}
              </Button>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
