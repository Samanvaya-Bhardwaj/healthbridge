import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { intelligenceApi } from '../../lib/domainApi.js';
import { authErrorMessage } from '../auth/errorMessages.js';
import { Alert } from '../../components/ui/Alert.jsx';
import { Badge } from '../../components/ui/Badge.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { Skeleton } from '../../components/ui/Skeleton.jsx';
import { EmptyState } from '../../components/ui/EmptyState.jsx';
import { FlaskConical, Sparkles } from 'lucide-react';

const FLAG_TONES = { high: 'warning', low: 'warning', normal: 'success' };

/**
 * AI-extracted values for one document, shown with their source quotes. They are
 * suggestions: only a treating doctor's verification makes them part of the record.
 */
export function ExtractionPanel({ documentId, canVerify = false }) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState([]);
  const extraction = useQuery({
    queryKey: ['extraction', documentId],
    queryFn: () => intelligenceApi.extraction(documentId),
  });
  const verify = useMutation({
    mutationFn: () => intelligenceApi.verify(documentId, selected),
    onSuccess: () => {
      setSelected([]);
      queryClient.invalidateQueries({ queryKey: ['extraction', documentId] });
      queryClient.invalidateQueries({ queryKey: ['lab-results'] });
    },
  });

  if (extraction.isPending) return <Skeleton className="h-16 w-full" />;
  if (extraction.isError) return <Alert tone="error">{authErrorMessage(extraction.error)}</Alert>;
  const x = extraction.data;
  if (!x) {
    return (
      <EmptyState compact icon={Sparkles} title="Not analysed">
        AI reading is off, or the document has not been processed yet. Patients can turn AI reading
        on in Health Records.
      </EmptyState>
    );
  }
  if (x.status === 'failed' || x.status === 'no_text') {
    return (
      <p className="text-sm text-text-muted">
        Values could not be read from this document automatically.
      </p>
    );
  }
  const toggle = (key) =>
    setSelected((s) => (s.includes(key) ? s.filter((k) => k !== key) : [...s, key]));

  return (
    <div className="space-y-3">
      <p className="flex flex-wrap items-center gap-2 text-sm text-text-muted">
        <Badge tone="primary">AI-extracted</Badge>
        Suggestions read from the document. They become part of the record only when a doctor
        verifies them.
        {x.needsReview && <Badge tone="warning">Needs review by a doctor</Badge>}
      </p>
      {x.injectionWarning && (
        <Alert tone="info">
          This document contains text that looks like instructions. It was treated as plain text.
        </Alert>
      )}
      {(x.documentDate || x.issuer) && (
        <p className="text-sm text-text">
          {x.issuer}
          {x.issuer && x.documentDate && ' · '}
          {x.documentDate}
        </p>
      )}
      {x.labResults.length === 0 ? (
        <EmptyState compact icon={FlaskConical} title="No lab values found in this document" />
      ) : (
        <table className="w-full text-left text-sm">
          <thead className="text-text-muted">
            <tr>
              {canVerify && <th className="py-1 pr-2" aria-label="Select" />}
              <th className="py-1 pr-2">Test</th>
              <th className="py-1 pr-2">Value</th>
              <th className="py-1 pr-2">Reference</th>
              <th className="py-1">Source</th>
            </tr>
          </thead>
          <tbody>
            {x.labResults.map((l) => (
              <tr key={l.key} className="border-t border-border align-top">
                {canVerify && (
                  <td className="py-1.5 pr-2">
                    {!l.verified && (
                      <input
                        type="checkbox"
                        aria-label={`Verify ${l.analyte}`}
                        checked={selected.includes(l.key)}
                        onChange={() => toggle(l.key)}
                      />
                    )}
                  </td>
                )}
                <td className="py-1.5 pr-2 text-text">
                  {l.analyte} {l.verified && <Badge tone="success">Verified</Badge>}
                </td>
                <td className="py-1.5 pr-2 text-text">
                  {l.value} {l.unit} {l.flag && <Badge tone={FLAG_TONES[l.flag]}>{l.flag}</Badge>}
                </td>
                <td className="py-1.5 pr-2 text-text-muted">{l.referenceRange ?? '—'}</td>
                <td className="py-1.5 font-mono text-xs text-text-subtle">“{l.quote}”</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {canVerify && x.labResults.some((l) => !l.verified) && (
        <div className="flex items-center gap-3">
          <Button onClick={() => verify.mutate()} disabled={!selected.length || verify.isPending}>
            Verify selected ({selected.length})
          </Button>
          {verify.isError && (
            <span className="text-sm text-danger">{authErrorMessage(verify.error)}</span>
          )}
        </div>
      )}
    </div>
  );
}

/** Verified lab values (part of the record). */
export function LabResults({ patientId }) {
  const labs = useQuery({
    queryKey: ['lab-results', patientId],
    queryFn: () => intelligenceApi.labResults(patientId),
    enabled: Boolean(patientId),
  });
  if (labs.isPending) return <Skeleton className="h-16 w-full" />;
  if (labs.isError) return <Alert tone="error">{authErrorMessage(labs.error)}</Alert>;
  if (!labs.data.length) {
    return (
      <EmptyState compact icon={FlaskConical} title="No verified lab values yet">
        When you upload lab reports, AI can propose the values (if you turn it on); a doctor checks
        them before they appear here.
      </EmptyState>
    );
  }
  return (
    <ul className="divide-y divide-border text-sm">
      {labs.data.map((l) => (
        <li key={l.id} className="flex flex-wrap justify-between gap-2 py-2">
          <span className="text-text">
            {l.analyte}: {l.value} {l.unit}{' '}
            {l.flag && <Badge tone={FLAG_TONES[l.flag]}>{l.flag}</Badge>}
          </span>
          <span className="text-text-subtle">
            {l.observedOn ?? 'date unknown'} · verified by {l.verifiedBy ?? 'a doctor'}
          </span>
        </li>
      ))}
    </ul>
  );
}
