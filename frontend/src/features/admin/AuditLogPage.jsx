import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useInfiniteQuery } from '@tanstack/react-query';
import { adminApi } from '../../lib/domainApi.js';
import { authErrorMessage } from '../auth/errorMessages.js';
import { Card } from '../../components/ui/Card.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { Badge } from '../../components/ui/Badge.jsx';
import { Skeleton } from '../../components/ui/Skeleton.jsx';
import { EmptyState } from '../../components/ui/EmptyState.jsx';
import { SelectField } from '../../components/ui/SelectField.jsx';
import { controlClass } from '../../components/ui/fieldStyles.js';
import { PageHeader } from '../../components/ui/Typography.jsx';
import { ScrollText } from 'lucide-react';
import { PlatformBoundary } from './AdminParts.jsx';

const CATEGORIES = [
  'authentication',
  'authorization',
  'account',
  'administration',
  'data_access',
  'system',
  'financial',
].map((c) => ({ value: c, label: c.replace('_', ' ') }));
const OUTCOMES = ['success', 'failure', 'denied'].map((o) => ({ value: o, label: o }));
const OUTCOME_TONES = { success: 'success', failure: 'warning', denied: 'danger' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESOURCES = [
  ['user', 'Account'],
  ['session', 'Sign-in session'],
  ['doctor', 'Doctor profile'],
  ['doctor_verification', 'Doctor verification'],
  ['clinic', 'Clinic'],
  ['clinic_membership', 'Clinic membership'],
  ['patient', 'Patient profile'],
  ['care_relationship', 'Care relationship'],
  ['consent', 'Consent'],
  ['appointment', 'Appointment'],
  ['payment', 'Payment'],
  ['medical_document', 'Medical document'],
  ['consultation', 'Consultation'],
  ['clinical_note', 'Clinical note'],
  ['prescription', 'Prescription'],
  ['follow_up', 'Follow-up'],
  ['dead_letter_job', 'Background job'],
  ['audit_log', 'Audit log'],
].map(([value, label]) => ({ value, label }));
/** Common actions, offered as suggestions; any action name can be typed. */
const COMMON_ACTIONS = [
  'auth.login',
  'auth.register',
  'auth.password_reset',
  'admin.user_read',
  'admin.user_status_update',
  'admin.doctor_verification_decision',
  'admin.doctor_suspend',
  'admin.doctor_verification_read',
  'consent.granted',
  'consent.revoked',
  'document.access_denied',
  'document.viewed',
  'payment.refund_requested',
  'operations.dead_letter_retry',
];
const EMPTY = {
  category: '',
  outcome: '',
  action: '',
  resourceType: '',
  actorUserId: '',
  patientId: '',
  requestId: '',
  from: '',
  to: '',
};

/** Text inputs are optional; malformed identifiers are rejected here before the server. */
function validateFilter(f) {
  if (f.actorUserId && !UUID.test(f.actorUserId)) return 'Actor must be a user ID.';
  if (f.patientId && !UUID.test(f.patientId)) return 'Patient must be a patient ID.';
  if (f.action && !/^[a-z_.]{1,80}$/.test(f.action)) return 'Use an action name like auth.login.';
  if (f.from && f.to && f.from > f.to) return 'The start date must be before the end date.';
  return null;
}

/** Dates are local calendar days; `to` is inclusive of the whole day. */
function toQuery(f) {
  const day = (d, offset = 0) => {
    const at = new Date(`${d}T00:00:00`);
    at.setDate(at.getDate() + offset);
    return at.toISOString();
  };
  return {
    ...f,
    from: f.from ? day(f.from) : '',
    to: f.to ? day(f.to, 1) : '',
  };
}

const FILTER_LABELS = {
  category: 'Category',
  outcome: 'Outcome',
  action: 'Action',
  resourceType: 'Resource',
  actorUserId: 'User',
  patientId: 'Patient',
  requestId: 'Request',
  from: 'From',
  to: 'To',
};

const short = (id) => (id ? `${id.slice(0, 8)}…` : '—');

function Field({ id, label, value, onChange, type = 'text', placeholder, list }) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-text">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        list={list}
        onChange={(e) => onChange(e.target.value.trim())}
        className={controlClass()}
      />
    </div>
  );
}

function AuditRow({ entry, onFilter }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr>
        <td className="whitespace-nowrap px-4 py-3 text-text-muted">
          {new Date(entry.occurredAt).toLocaleString('en-IN')}
        </td>
        <td className="px-4 py-3">
          <div className="font-mono text-xs text-text">{entry.action}</div>
          <div className="text-xs text-text-subtle">{entry.category.replace('_', ' ')}</div>
        </td>
        <td className="px-4 py-3">
          <Badge tone={OUTCOME_TONES[entry.outcome] ?? 'neutral'}>{entry.outcome}</Badge>
        </td>
        <td className="px-4 py-3">
          {entry.actor.userId ? (
            <button
              type="button"
              className="font-mono text-xs text-primary underline-offset-2 hover:underline"
              title="Show only this actor"
              onClick={() => onFilter({ actorUserId: entry.actor.userId })}
            >
              {short(entry.actor.userId)}
            </button>
          ) : (
            <span className="text-xs text-text-subtle">{entry.actor.type}</span>
          )}
          {entry.actor.roles?.length > 0 && (
            <div className="text-xs text-text-subtle">{entry.actor.roles.join(', ')}</div>
          )}
        </td>
        <td className="px-4 py-3 text-xs">
          {entry.resource ? (
            <>
              {entry.resource.type}
              <div className="font-mono text-text-subtle">{short(entry.resource.id)}</div>
            </>
          ) : (
            '—'
          )}
          {entry.patientId && (
            <button
              type="button"
              className="mt-1 block font-mono text-primary underline-offset-2 hover:underline"
              title="Show only this patient's record access"
              onClick={() => onFilter({ patientId: entry.patientId })}
            >
              patient {short(entry.patientId)}
            </button>
          )}
        </td>
        <td className="px-4 py-3 text-right">
          <Button variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? 'Hide' : 'Details'}
          </Button>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={6} className="bg-surface-muted px-4 py-3">
            <dl className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
              <div>
                <dt className="text-text-subtle">Request ID</dt>
                <dd>
                  {entry.requestId ? (
                    <button
                      type="button"
                      className="font-mono text-primary underline-offset-2 hover:underline"
                      onClick={() => onFilter({ requestId: entry.requestId })}
                    >
                      {entry.requestId}
                    </button>
                  ) : (
                    '—'
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-text-subtle">Reason</dt>
                <dd>{entry.reason ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-text-subtle">IP address</dt>
                <dd className="font-mono">{entry.ip ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-text-subtle">Session</dt>
                <dd className="font-mono">{entry.sessionId ?? '—'}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-text-subtle">User agent</dt>
                <dd className="break-all">{entry.userAgent ?? '—'}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-text-subtle">Metadata</dt>
                <dd>
                  {Object.keys(entry.metadata ?? {}).length === 0 ? (
                    '—'
                  ) : (
                    <dl className="mt-1 grid grid-cols-1 gap-x-4 gap-y-1 rounded-lg bg-surface-raised p-3 sm:grid-cols-[auto_1fr]">
                      {Object.entries(entry.metadata).map(([k, v]) => (
                        <div key={k} className="contents">
                          <dt className="font-mono text-text-subtle">{k}</dt>
                          <dd className="break-all font-mono text-text">
                            {v === null || ['string', 'number', 'boolean'].includes(typeof v)
                              ? String(v)
                              : Array.isArray(v) && v.every((x) => typeof x !== 'object')
                                ? v.join(', ')
                                : JSON.stringify(v)}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  <p className="mt-1 text-text-subtle">
                    Identifiers and reason codes only; audit entries never contain clinical content.
                  </p>
                </dd>
              </div>
            </dl>
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * Platform admin: the append-only audit trail (ADR-0016). Entries carry identifiers and
 * reason codes only — never medical content. Reading the trail is itself audited.
 */
export function AuditLogPage() {
  const [params] = useSearchParams();
  const [initial] = useState(() =>
    Object.fromEntries(Object.keys(EMPTY).map((k) => [k, params.get(k) ?? ''])),
  );
  const [draft, setDraft] = useState(initial);
  const [filter, setFilter] = useState(initial);
  const [error, setError] = useState(null);
  const audit = useInfiniteQuery({
    queryKey: ['admin', 'audit', filter],
    queryFn: ({ pageParam }) => adminApi.auditLogs({ ...toQuery(filter), cursor: pageParam }),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.meta?.nextCursor ?? undefined,
  });
  const rows = audit.data?.pages.flatMap((p) => p.data) ?? [];
  const set = (key) => (value) => setDraft({ ...draft, [key]: value });
  const apply = (next) => {
    const problem = validateFilter(next);
    setError(problem);
    if (!problem) setFilter(next);
  };
  const narrow = (extra) => {
    const next = { ...filter, ...extra };
    setDraft(next);
    apply(next);
  };
  const active = Object.values(filter).some(Boolean);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={ScrollText}
        eyebrow="Oversight"
        title="Audit log"
        description="Security and access events, newest first. Entries cannot be changed or deleted, and reading this log is itself recorded."
      />
      <PlatformBoundary compact />
      <Card>
        <form
          className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
          onSubmit={(e) => {
            e.preventDefault();
            apply(draft);
          }}
        >
          <SelectField
            label="Category"
            placeholder="Any category"
            value={draft.category}
            onChange={(e) => set('category')(e.target.value)}
            options={CATEGORIES}
          />
          <SelectField
            label="Outcome"
            placeholder="Any outcome"
            value={draft.outcome}
            onChange={(e) => set('outcome')(e.target.value)}
            options={OUTCOMES}
          />
          <div>
            <Field
              id="audit-action"
              label="Action"
              value={draft.action}
              onChange={set('action')}
              placeholder="e.g. auth.login"
              list="audit-actions"
            />
            <datalist id="audit-actions">
              {COMMON_ACTIONS.map((a) => (
                <option key={a} value={a} />
              ))}
            </datalist>
          </div>
          <SelectField
            label="Resource"
            placeholder="Any resource"
            value={draft.resourceType}
            onChange={(e) => set('resourceType')(e.target.value)}
            options={RESOURCES}
          />
          <Field
            id="audit-request"
            label="Request ID"
            value={draft.requestId}
            onChange={set('requestId')}
          />
          <Field
            id="audit-actor"
            label="User (who acted)"
            value={draft.actorUserId}
            onChange={set('actorUserId')}
            placeholder="User ID, from Users or a row below"
          />
          <Field
            id="audit-patient"
            label="Patient ID"
            value={draft.patientId}
            onChange={set('patientId')}
            placeholder="Shows who accessed a patient’s record"
          />
          <Field
            id="audit-from"
            label="From"
            type="date"
            value={draft.from}
            onChange={set('from')}
          />
          <Field id="audit-to" label="To" type="date" value={draft.to} onChange={set('to')} />
          <div className="flex flex-wrap items-center gap-2 sm:col-span-2 lg:col-span-4">
            <Button type="submit">Apply filters</Button>
            <span className="text-sm text-text-muted">Quick range:</span>
            {[
              ['Today', 0],
              ['Last 7 days', 6],
              ['Last 30 days', 29],
            ].map(([label, days]) => (
              <Button
                key={label}
                size="sm"
                variant="ghost"
                onClick={() => {
                  const d = new Date();
                  const iso = (x) =>
                    `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
                  const start = new Date(d.getTime() - days * 86_400_000);
                  const next = { ...draft, from: iso(start), to: iso(d) };
                  setDraft(next);
                  apply(next);
                }}
              >
                {label}
              </Button>
            ))}
            {active && (
              <Button
                variant="ghost"
                onClick={() => {
                  setDraft(EMPTY);
                  setError(null);
                  setFilter(EMPTY);
                }}
              >
                Clear
              </Button>
            )}
          </div>
        </form>
        {error && (
          <Alert tone="error" className="mt-3">
            {error}
          </Alert>
        )}
      </Card>

      {active && (
        <div className="flex flex-wrap items-center gap-2 text-sm" aria-label="Active filters">
          <span className="text-text-muted">Showing:</span>
          {Object.entries(filter)
            .filter(([, v]) => v)
            .map(([k, v]) => (
              <button
                key={k}
                type="button"
                onClick={() => narrow({ [k]: '' })}
                className="inline-flex items-center gap-1 rounded-full bg-primary-soft px-3 py-1 text-xs text-primary hover:bg-primary/15"
                aria-label={`Remove filter ${FILTER_LABELS[k]}: ${v}`}
              >
                {FILTER_LABELS[k]}: <span className="font-mono">{v}</span> ×
              </button>
            ))}
        </div>
      )}
      {audit.isPending ? (
        <Skeleton className="h-64" />
      ) : audit.isError ? (
        <Alert tone="error">{authErrorMessage(audit.error)}</Alert>
      ) : rows.length === 0 ? (
        <EmptyState title="No audit entries">No entries match these filters.</EmptyState>
      ) : (
        <div
          role="region"
          aria-label="Audit entries table"
          tabIndex={0}
          className="relative overflow-x-auto rounded-2xl border border-border bg-surface-raised"
        >
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Audit entries</caption>
            <thead className="border-b border-border text-text-subtle">
              <tr>
                {['When', 'Action', 'Outcome', 'Actor', 'Resource'].map((h) => (
                  <th key={h} scope="col" className="px-4 py-3 font-medium">
                    {h}
                  </th>
                ))}
                <th scope="col" className="px-4 py-3">
                  <span className="sr-only">Details</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((entry) => (
                <AuditRow key={entry.id} entry={entry} onFilter={narrow} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {audit.hasNextPage && (
        <Button
          variant="secondary"
          disabled={audit.isFetchingNextPage}
          onClick={() => audit.fetchNextPage()}
        >
          Load older entries
        </Button>
      )}
    </div>
  );
}
