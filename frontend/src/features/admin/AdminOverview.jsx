import { Link } from 'react-router';
import { useQueries, useQuery } from '@tanstack/react-query';
import {
  BadgeCheck,
  Ban,
  Building2,
  ChevronRight,
  LayoutDashboard,
  ScrollText,
  ServerCog,
  ShieldAlert,
  UserX,
  Users,
} from 'lucide-react';
import { adminApi } from '../../lib/domainApi.js';
import { Alert } from '../../components/ui/Alert.jsx';
import { PageHeader, SectionHeader } from '../../components/ui/Typography.jsx';
import { PlatformBoundary } from './AdminParts.jsx';
import { platformHealth } from './adminHealth.js';

function Work({ icon: Icon, label, value, to, tone = 'primary', hint }) {
  return (
    <Link
      to={to}
      className="flex items-start gap-3 rounded-2xl border border-border bg-surface-raised p-4 hover:border-primary/40"
    >
      <span
        aria-hidden="true"
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
          tone === 'danger'
            ? 'bg-danger/10 text-danger'
            : tone === 'warning'
              ? 'bg-warning/15 text-warning'
              : 'bg-primary-soft text-primary'
        }`}
      >
        <Icon className="h-5 w-5" />
      </span>
      <span className="min-w-0">
        <span className="block text-2xl font-semibold tabular-nums text-text">{value}</span>
        <span className="block text-sm text-text">{label}</span>
        {hint && <span className="mt-0.5 block text-xs text-text-muted">{hint}</span>}
      </span>
      <ChevronRight aria-hidden="true" className="ml-auto h-4 w-4 self-center text-text-subtle" />
    </Link>
  );
}

function Shortcut({ icon: Icon, to, title, text }) {
  return (
    <Link
      to={to}
      className="flex items-start gap-3 rounded-xl border border-border bg-surface-raised px-4 py-3 hover:border-primary/40"
    >
      <Icon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
      <span>
        <span className="block text-sm font-medium text-text">{title}</span>
        <span className="block text-xs text-text-muted">{text}</span>
      </span>
    </Link>
  );
}

const daysAgo = (n) => {
  const d = new Date(Date.now() - n * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * Platform admin home: platform health and pending work. Account lists and the audit trail
 * are opened on demand (reading them is itself audited), not loaded here.
 */
export function AdminOverview({ firstName }) {
  const [pending, review] = useQueries({
    queries: ['pending', 'under_review'].map((status) => ({
      queryKey: ['admin', 'verifications', status],
      queryFn: () => adminApi.verificationQueue(status),
    })),
  });
  const ops = useQuery({
    queryKey: ['admin', 'operations', 'summary'],
    queryFn: adminApi.operationsSummary,
    refetchInterval: 30_000,
  });
  const clinics = useQuery({ queryKey: ['admin', 'clinics'], queryFn: adminApi.clinics });
  const waiting = (pending.data?.length ?? 0) + (review.data?.length ?? 0);
  const dead = ops.data?.deadLetters?.open ?? 0;
  const inactive = (clinics.data ?? []).filter((c) => c.status === 'inactive').length;
  const health = ops.data && platformHealth(ops.data);

  return (
    <div className="space-y-8">
      <PageHeader
        icon={LayoutDashboard}
        eyebrow="Platform administration"
        title="Overview"
        description={`Hello, ${firstName}. Platform health and the work waiting for you.`}
      />
      <PlatformBoundary />
      {health && (
        <Alert tone={health.tone} title={`Background jobs: ${health.title.toLowerCase()}`}>
          {health.text}
        </Alert>
      )}

      <section aria-labelledby="work-heading" className="space-y-3">
        <SectionHeader id="work-heading" title="Waiting for you" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <Work
            icon={BadgeCheck}
            label="Doctor applications to review"
            value={pending.isPending || review.isPending ? '…' : waiting}
            hint={
              review.data?.length
                ? `${review.data.length} in review · ${pending.data?.length ?? 0} waiting`
                : 'Check registrations before patients can book them'
            }
            to="/app/admin/verification"
            tone={waiting ? 'warning' : 'primary'}
          />
          <Work
            icon={ServerCog}
            label="Background jobs that gave up"
            value={ops.isPending ? '…' : dead}
            hint={dead ? 'Fix the cause, then retry' : 'Nothing needs a retry'}
            to="/app/admin/operations"
            tone={dead ? 'danger' : 'primary'}
          />
          <Work
            icon={Building2}
            label="Clinics"
            value={clinics.isPending ? '…' : (clinics.data?.length ?? 0)}
            hint={inactive ? `${inactive} inactive` : 'All active'}
            to="/app/admin/clinics"
          />
        </div>
      </section>

      <section aria-labelledby="checks-heading" className="space-y-3">
        <SectionHeader
          id="checks-heading"
          title="Checks and lookups"
          description="These open on demand: looking at accounts and the audit trail is itself recorded."
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Shortcut
            icon={Users}
            to="/app/admin/users"
            title="Find an account"
            text="Search by name or email; disable, reinstate or sign out everywhere."
          />
          <Shortcut
            icon={UserX}
            to="/app/admin/users?status=disabled"
            title="Disabled accounts"
            text="Accounts that cannot sign in, and why."
          />
          <Shortcut
            icon={ShieldAlert}
            to={`/app/admin/audit?outcome=denied&from=${daysAgo(7)}`}
            title="Refused access, last 7 days"
            text="Attempts the permission and consent checks stopped."
          />
          <Shortcut
            icon={Ban}
            to={`/app/admin/audit?category=authentication&outcome=failure&from=${daysAgo(1)}`}
            title="Failed sign-ins, last 24 hours"
            text="Spot password guessing or locked-out users."
          />
          <Shortcut
            icon={ScrollText}
            to="/app/admin/audit?category=administration"
            title="Administrator actions"
            text="Everything administrators changed, newest first."
          />
        </div>
      </section>
    </div>
  );
}
