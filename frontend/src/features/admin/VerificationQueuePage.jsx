import { useState } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, Ban, ClipboardCheck, FileSearch, ShieldOff, XCircle } from 'lucide-react';
import { adminApi } from '../../lib/domainApi.js';
import { authErrorMessage } from '../auth/errorMessages.js';
import { Card } from '../../components/ui/Card.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { StatusBadge } from '../../components/ui/Badge.jsx';
import { EmptyState, LoadingState } from '../../components/ui/EmptyState.jsx';
import { PersonIdentity } from '../../components/ui/Identity.jsx';
import { PageHeader } from '../../components/ui/Typography.jsx';
import { Tabs } from '../../components/ui/Tabs.jsx';
import { ActionDialog, PlatformBoundary } from './AdminParts.jsx';
import { useSafeMutation } from '../../lib/useSafeMutation.js';
import { formatFullDateTime } from '../appointments/format.js';

const TABS = [
  ['pending', 'Waiting'],
  ['under_review', 'In review'],
  ['verified', 'Verified'],
  ['rejected', 'Rejected'],
  ['suspended', 'Suspended'],
];
const TAB_HELP = {
  pending: 'Submitted and not yet picked up. Start a review to take an application.',
  under_review:
    'Being checked. Compare the registration with the medical council register, then verify or reject.',
  verified:
    'Doctors patients can find and book. Suspend one if their registration lapses or a serious concern is raised.',
  rejected: 'Not approved. The doctor can correct their details and submit again.',
  suspended: 'Removed from search and booking. The doctor can submit again for a new review.',
};
const REASON_LABELS = {
  credentials_confirmed: 'Credentials confirmed',
  registration_not_found: 'Registration not found in the council register',
  registration_mismatch: 'Registration details don’t match the register',
  documents_insufficient: 'Not enough supporting information',
  duplicate_application: 'Duplicate application',
  registration_lapsed: 'Registration has lapsed',
  misconduct_report: 'Misconduct report',
  other: 'Other',
};
const NEGATIVE = Object.keys(REASON_LABELS)
  .filter((r) => r !== 'credentials_confirmed')
  .map((value) => ({ value, label: REASON_LABELS[value] }));
const when = (v) => (v ? formatFullDateTime(v) : '—');

function Row({ label, children, className }) {
  return (
    <div className={className}>
      <dt className="text-xs font-semibold uppercase tracking-wide text-text-subtle">{label}</dt>
      <dd className="mt-0.5 text-sm text-text">{children || '—'}</dd>
    </div>
  );
}

/** The full application: everything the doctor submitted, loaded (and audited) when opened. */
function Application({ item }) {
  const detail = useQuery({
    queryKey: ['admin', 'verification', item.id],
    queryFn: () => adminApi.verificationCase(item.id),
  });
  if (detail.isPending) return <LoadingState label="Loading application" rows={2} />;
  if (detail.isError) return <Alert tone="error">{authErrorMessage(detail.error)}</Alert>;
  const p = detail.data.doctorProfile;
  return (
    <dl className="grid grid-cols-1 gap-4 rounded-xl bg-surface-muted p-4 sm:grid-cols-2">
      <Row label="Name shown to patients">{p.professionalName}</Row>
      <Row label="Profile created">{when(p.createdAt)}</Row>
      <Row label="Registration number">{item.registrationNumber}</Row>
      <Row label="Medical council">
        {item.registrationCouncil}
        {item.registrationYear ? ` · registered ${item.registrationYear}` : ''}
      </Row>
      <Row label="Speciality">
        {[p.primarySpecialization, ...(p.additionalSpecializations ?? [])].join(', ')}
      </Row>
      <Row label="Experience">{`${p.yearsOfExperience} years`}</Row>
      <Row label="Qualifications">
        {p.qualifications?.length ? (
          <ul>
            {p.qualifications.map((q) => (
              <li key={`${q.degree}-${q.year}`}>
                {q.degree}, {q.institution} ({q.year})
              </li>
            ))}
          </ul>
        ) : null}
      </Row>
      <Row label="Languages">{p.languages?.join(', ')}</Row>
      <Row label="About" className="sm:col-span-2">
        {p.bio}
      </Row>
    </dl>
  );
}

function CaseCard({ item, onChanged }) {
  // Applications in review open by default (also right after “Start review”).
  const [chosen, setOpen] = useState(null);
  const open = chosen ?? item.status === 'under_review';
  const [dialog, setDialog] = useState(null);
  const name = item.doctor?.professionalName ?? 'Doctor';
  const start = useSafeMutation({
    mutationFn: () => adminApi.startReview(item.id),
    onSuccess: onChanged,
  });
  const decide = useSafeMutation({
    mutationFn: (body) => adminApi.decide(item.id, body),
    onSuccess: (_result, body) => {
      setDialog(null);
      onChanged(
        body.decision === 'verified'
          ? `${name} is verified. Patients can now find and book them.`
          : `${name}’s application was not approved. The decision is recorded in the audit log.`,
      );
    },
  });
  const suspend = useSafeMutation({
    mutationFn: (body) => adminApi.suspendDoctor(item.doctorId, body),
    onSuccess: () => {
      setDialog(null);
      onChanged(`${name} is suspended and no longer shown to patients.`);
    },
  });
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <PersonIdentity
              name={name}
              tone="neutral"
              detail={item.doctor?.primarySpecialization}
            />
            <StatusBadge status={item.status} />
          </div>
          <p className="text-sm text-text-muted">
            Reg. no. <span className="font-mono text-text">{item.registrationNumber}</span> ·{' '}
            {item.registrationCouncil}
            {item.registrationYear ? ` (${item.registrationYear})` : ''} · submitted{' '}
            {when(item.submittedAt)}
          </p>
          {item.decisionReasonCode && item.status !== 'under_review' && (
            <p className="text-sm text-text">
              <span className="font-medium">
                {item.status === 'verified' ? 'Decision' : 'Reason'}:
              </span>{' '}
              {REASON_LABELS[item.decisionReasonCode] ?? item.decisionReasonCode}
              {item.decidedAt && ` · ${when(item.decidedAt)}`}
              {item.decisionNotes && (
                <span className="block text-text-muted">Notes: {item.decisionNotes}</span>
              )}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {item.status === 'pending' && (
            <Button icon={ClipboardCheck} onClick={() => start.mutate()} loading={start.isPending}>
              Start review
            </Button>
          )}
          <Button
            variant="secondary"
            icon={FileSearch}
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? 'Hide application' : 'View application'}
          </Button>
        </div>
      </div>
      {start.isError && (
        <Alert tone="error" className="mt-3">
          {authErrorMessage(start.error)}
        </Alert>
      )}
      {open && (
        <div className="mt-4 space-y-4">
          <Application item={item} />
          {item.status === 'under_review' && (
            <div className="flex flex-wrap gap-2">
              <Button icon={BadgeCheck} onClick={() => setDialog('verify')}>
                Verify doctor
              </Button>
              <Button variant="secondary" icon={XCircle} onClick={() => setDialog('reject')}>
                Reject
              </Button>
            </div>
          )}
          {item.status === 'verified' && (
            <Button variant="ghost" icon={Ban} onClick={() => setDialog('suspend')}>
              Suspend doctor
            </Button>
          )}
        </div>
      )}
      {dialog === 'verify' && (
        <ActionDialog
          title={`Verify ${name}?`}
          description="Patients will be able to find and book this doctor. The decision is recorded in the audit log."
          confirmLabel="Verify doctor"
          notes
          acknowledge={`I checked registration ${item.registrationNumber} with ${item.registrationCouncil} and the details match.`}
          pending={decide.isPending}
          error={decide.error}
          onConfirm={({ notes }) =>
            decide.mutate({
              decision: 'verified',
              reasonCode: 'credentials_confirmed',
              ...(notes ? { notes } : {}),
            })
          }
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'reject' && (
        <ActionDialog
          title={`Reject ${name}’s application?`}
          description="The doctor is not listed. They see the reason and can correct their details and submit again."
          confirmLabel="Reject application"
          reasons={NEGATIVE}
          reasonLabel="Why are you rejecting it?"
          notes
          destructive
          pending={decide.isPending}
          error={decide.error}
          onConfirm={({ reasonCode, notes }) =>
            decide.mutate({ decision: 'rejected', reasonCode, ...(notes ? { notes } : {}) })
          }
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'suspend' && (
        <ActionDialog
          title={`Suspend ${name}?`}
          description="They disappear from search at once and patients can no longer book them. Appointments already booked are not cancelled automatically. The doctor can submit again for review."
          confirmLabel="Suspend doctor"
          reasons={NEGATIVE}
          reasonLabel="Why are you suspending them?"
          notes
          destructive
          acknowledge="I understand this stops new bookings with this doctor immediately."
          pending={suspend.isPending}
          error={suspend.error}
          onConfirm={({ reasonCode, notes }) =>
            suspend.mutate({ reasonCode, ...(notes ? { notes } : {}) })
          }
          onClose={() => setDialog(null)}
        />
      )}
    </Card>
  );
}

/** Platform admin: doctor credential verification. */
export function VerificationQueuePage() {
  const queryClient = useQueryClient();
  const counts = useQueries({
    queries: TABS.map(([status]) => ({
      queryKey: ['admin', 'verifications', status],
      queryFn: () => adminApi.verificationQueue(status),
    })),
  });
  const [chosen, setTab] = useState(null);
  // Open on the work waiting: applications in review first, then new ones.
  const tab =
    chosen ??
    (counts[1].data?.length ? 'under_review' : counts[0].data?.length ? 'pending' : 'pending');
  const index = TABS.findIndex(([s]) => s === tab);
  const list = counts[index];
  const [done, setDone] = useState(null);
  const refresh = (message) => {
    queryClient.invalidateQueries({ queryKey: ['admin', 'verifications'] });
    setDone(typeof message === 'string' ? message : null);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        icon={BadgeCheck}
        eyebrow="Administration"
        title="Doctor verification"
        description="Check each registration against the medical council register before verifying. Only verified doctors appear to patients. Every decision is recorded in the audit log."
      />
      <PlatformBoundary compact />
      <Tabs
        label="Applications"
        value={tab}
        onChange={setTab}
        tabs={TABS.map(([status, label], i) => [
          status,
          `${label}${counts[i].data?.length ? ` (${counts[i].data.length})` : ''}`,
          status === 'suspended' ? ShieldOff : undefined,
        ])}
      />
      <p className="text-sm text-text-muted">{TAB_HELP[tab]}</p>
      {done && <Alert tone="success">{done}</Alert>}
      {list.isPending && <LoadingState label="Loading applications" rows={2} />}
      {list.isError && <Alert tone="error">{authErrorMessage(list.error)}</Alert>}
      {list.isSuccess && list.data.length === 0 && (
        <EmptyState icon={BadgeCheck} title="Nothing here">
          {tab === 'pending'
            ? 'No applications are waiting. New ones appear here when doctors submit their profile.'
            : 'No applications in this group.'}
        </EmptyState>
      )}
      <ul className="space-y-3">
        {list.data?.map((item) => (
          <li key={item.id}>
            <CaseCard item={item} onChanged={refresh} />
          </li>
        ))}
      </ul>
    </div>
  );
}
