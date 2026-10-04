import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  BadgeCheck,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  Circle,
  HeartPulse,
  LayoutDashboard,
  LifeBuoy,
  ServerCog,
  Stethoscope,
  UserRound,
  UsersRound,
} from 'lucide-react';
import { ROLE_LABELS } from '@healthbridge/shared';
import { useAuth } from '../auth/authContext.js';
import { navigationFor, primaryRole } from '../../app/navigation.js';
import { Card } from '../../components/ui/Card.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { StatusBadge } from '../../components/ui/Badge.jsx';
import { ButtonLink } from '../../components/ui/Button.jsx';
import { EmptyState, LoadingState } from '../../components/ui/EmptyState.jsx';
import { PageHeader, SectionHeader } from '../../components/ui/Typography.jsx';
import { ApiError } from '../../lib/apiClient.js';
import { adminApi } from '../../lib/domainApi.js';
import { PatientHome } from './PatientHome.jsx';
import { DoctorToday } from './DoctorToday.jsx';
import { ClinicOverview } from '../clinics/ClinicOverview.jsx';
import { adminClinicIds } from '../clinics/clinicWork.js';

/** In a medical emergency, HealthBridge is never the right first step. */
function EmergencyNote() {
  return (
    <Alert tone="warning" title="In a medical emergency">
      Call 112 or 108 for an ambulance, or go to the nearest emergency department. Do not wait for
      an online consultation.
    </Alert>
  );
}

/** Quick links to the role's sections, with the plain-language descriptions. */
function SectionLinks({ user, exclude = [] }) {
  const sections = navigationFor(user).filter(
    (item) => item.description && item.path && !exclude.includes(item.key),
  );
  if (!sections.length) return null;
  return (
    <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {sections.map((item) => {
        const Icon = item.icon;
        return (
          <li key={item.key}>
            <Link
              to={`/app/${item.path}`}
              className="group flex h-full items-start gap-3 rounded-2xl border border-border bg-surface-raised p-4 transition-colors hover:border-primary/40 focus-visible:outline-offset-4"
            >
              {Icon && (
                <span
                  aria-hidden="true"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary"
                >
                  <Icon className="h-5 w-5" />
                </span>
              )}
              <span className="min-w-0">
                <span className="block font-medium text-text">{item.label}</span>
                <span className="mt-0.5 block text-sm leading-relaxed text-text-muted">
                  {item.description}
                </span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

// ── Platform admin ───────────────────────────────────────────────────

function Stat({ icon: Icon, label, value, to, tone = 'primary', hint }) {
  return (
    <Link
      to={to}
      className="flex items-start gap-3 rounded-2xl border border-border bg-surface-raised p-4 hover:border-primary/40"
    >
      <span
        aria-hidden="true"
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
          tone === 'danger' ? 'bg-danger/10 text-danger' : 'bg-primary-soft text-primary'
        }`}
      >
        <Icon className="h-5 w-5" />
      </span>
      <span className="min-w-0">
        <span className="block text-2xl font-semibold tabular-nums text-text">{value}</span>
        <span className="block text-sm text-text-muted">{label}</span>
        {hint && <span className="mt-0.5 block text-xs text-text-subtle">{hint}</span>}
      </span>
      <ChevronRight aria-hidden="true" className="ml-auto h-4 w-4 self-center text-text-subtle" />
    </Link>
  );
}

function AdminHome({ user, firstName }) {
  const pending = useQuery({
    queryKey: ['admin', 'verification', 'pending'],
    queryFn: () => adminApi.verificationQueue('pending'),
  });
  const review = useQuery({
    queryKey: ['admin', 'verification', 'under_review'],
    queryFn: () => adminApi.verificationQueue('under_review'),
  });
  const ops = useQuery({
    queryKey: ['admin', 'operations', 'summary'],
    queryFn: adminApi.operationsSummary,
  });
  const waiting = (pending.data?.length ?? 0) + (review.data?.length ?? 0);
  const deadLetters = ops.data?.deadLetters?.open ?? 0;
  return (
    <div className="space-y-8">
      <PageHeader
        icon={LayoutDashboard}
        eyebrow={ROLE_LABELS.PLATFORM_ADMIN}
        title="Overview"
        description={`Hello, ${firstName}. Administration never includes access to patients’ medical records.`}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <Stat
          icon={BadgeCheck}
          label="Doctors waiting for verification"
          value={pending.isPending || review.isPending ? '…' : waiting}
          to="/app/admin/verification"
        />
        <Stat
          icon={ServerCog}
          label="Background jobs needing attention"
          value={ops.isPending ? '…' : deadLetters}
          to="/app/admin/operations"
          tone={deadLetters > 0 ? 'danger' : 'primary'}
          hint={
            ops.data && !ops.data.queues
              ? 'Job queue unreachable: events wait in the outbox'
              : undefined
          }
        />
      </div>
      <SectionLinks user={user} />
    </div>
  );
}

// ── Support ──────────────────────────────────────────────────────────

function SupportHome({ user, firstName }) {
  return (
    <div className="space-y-8">
      <PageHeader
        icon={LifeBuoy}
        eyebrow={ROLE_LABELS.SUPPORT}
        title={`Hello, ${firstName}`}
        description="Look up accounts to help people sign in and find their way. Support never sees medical records and cannot change accounts."
      />
      <SectionLinks user={user} />
    </div>
  );
}

/** Signed-in landing page, specific to the user's primary role. */
export function RoleHome() {
  const { user } = useAuth();
  const role = primaryRole(user.roles);
  const firstName = user.fullName.split(' ')[0];
  if (role === 'DOCTOR') return <DoctorToday firstName={firstName} />;
  if (role === 'CLINIC_ADMIN')
    return <ClinicOverview clinicId={adminClinicIds(user)[0]} firstName={firstName} />;
  if (role === 'PLATFORM_ADMIN') return <AdminHome user={user} firstName={firstName} />;
  if (role === 'SUPPORT') return <SupportHome user={user} firstName={firstName} />;
  return <PatientHome firstName={firstName} />;
}
