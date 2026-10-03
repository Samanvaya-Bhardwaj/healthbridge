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
import {
  adminApi,
  careApi,
  doctorsApi,
  followUpApi,
  patientsApi,
  schedulingApi,
} from '../../lib/domainApi.js';
import { MODE_LABELS, formatDateTime, formatTime } from '../appointments/format.js';

const todayRange = () => {
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setDate(to.getDate() + 1);
  return { from: from.toISOString(), to: to.toISOString() };
};
const longDate = () =>
  new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: 'numeric', month: 'long' }).format(
    new Date(),
  );

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

// ── Patient ──────────────────────────────────────────────────────────

function Step({ done, title, children, action }) {
  return (
    <li className="flex gap-3 py-3">
      {done ? (
        <CheckCircle2 aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-success" />
      ) : (
        <Circle aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-text-subtle" />
      )}
      <div className="min-w-0 flex-1">
        <p className={`font-medium ${done ? 'text-text-muted line-through' : 'text-text'}`}>
          {title}
          <span className="sr-only">{done ? ' (done)' : ' (to do)'}</span>
        </p>
        {!done && <p className="mt-0.5 text-sm text-text-muted">{children}</p>}
      </div>
      {!done && action}
    </li>
  );
}

function PatientHome({ user, firstName }) {
  const profile = useQuery({ queryKey: ['patients', 'me'], queryFn: patientsApi.me, retry: false });
  const hasProfile = Boolean(profile.data);
  const missing = profile.error instanceof ApiError && profile.error.status === 404;
  const care = useQuery({
    queryKey: ['care', profile.data?.id],
    queryFn: () => careApi.list(profile.data.id),
    enabled: hasProfile,
  });
  const upcoming = useQuery({
    queryKey: ['appointments', undefined, 'upcoming'],
    queryFn: () => schedulingApi.mine({ scope: 'upcoming' }),
    enabled: hasProfile,
  });
  const hasDoctor = care.data?.some((r) => r.status === 'active') ?? false;
  const hasBooking = (upcoming.data?.length ?? 0) > 0;
  const loading = profile.isPending || (hasProfile && (care.isPending || upcoming.isPending));
  const allDone = hasProfile && hasDoctor && hasBooking;

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={ROLE_LABELS.PATIENT}
        title={`Welcome, ${firstName}`}
        description="Stay in touch with the doctors you trust. Consult online first, and visit only when your doctor says you need to."
      />
      {loading ? (
        <LoadingState label="Loading your home page" rows={2} />
      ) : (
        <>
          {!allDone && (
            <Card>
              <SectionHeader
                title="Getting started"
                description="Three steps to your first consultation."
              />
              <ol className="mt-2 divide-y divide-border">
                <Step
                  done={hasProfile}
                  title="Create your health profile"
                  action={
                    <ButtonLink as={Link} to="/app/profile" size="sm" icon={UserRound}>
                      Create
                    </ButtonLink>
                  }
                >
                  Your basic details. Doctors see them only after you add them to your care team.
                </Step>
                <Step
                  done={hasDoctor}
                  title="Add your doctor"
                  action={
                    hasProfile && (
                      <ButtonLink as={Link} to="/app/doctors" size="sm" icon={Stethoscope}>
                        Find
                      </ButtonLink>
                    )
                  }
                >
                  Search for your family doctor and send a request; they accept it.
                </Step>
                <Step
                  done={hasBooking}
                  title="Book a consultation"
                  action={
                    hasDoctor && (
                      <ButtonLink as={Link} to="/app/doctors" size="sm" icon={CalendarDays}>
                        Book
                      </ButtonLink>
                    )
                  }
                >
                  Choose online or in-clinic and a time that suits you.
                </Step>
              </ol>
              {missing && <p className="mt-2 text-sm text-text-subtle">Start with step 1.</p>}
            </Card>
          )}
          {hasProfile && (
            <section aria-labelledby="upcoming-heading" className="space-y-3">
              <SectionHeader
                id="upcoming-heading"
                icon={CalendarDays}
                title="Upcoming appointments"
                actions={
                  hasBooking && (
                    <ButtonLink as={Link} to="/app/appointments" variant="subtle" size="sm">
                      All appointments
                    </ButtonLink>
                  )
                }
              />
              {hasBooking ? (
                <ul className="space-y-2">
                  {upcoming.data.slice(0, 3).map((a) => (
                    <li key={a.id}>
                      <Link
                        to="/app/appointments"
                        className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-surface-raised px-4 py-3 hover:border-primary/40"
                      >
                        <span>
                          <span className="block font-medium text-text">
                            {formatDateTime(a.startsAt)}
                          </span>
                          <span className="block text-sm text-text-muted">
                            {a.doctor?.professionalName} · {MODE_LABELS[a.mode]}
                          </span>
                        </span>
                        <StatusBadge status={a.status} />
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState compact icon={CalendarDays} title="No upcoming appointments">
                  When you book a consultation, it appears here.
                </EmptyState>
              )}
            </section>
          )}
        </>
      )}
      <EmergencyNote />
      <section aria-labelledby="sections-heading" className="space-y-3">
        <SectionHeader id="sections-heading" title="Everything in one place" />
        <SectionLinks user={user} />
      </section>
    </div>
  );
}

// ── Doctor ───────────────────────────────────────────────────────────

const ATTENTION = ['urgent', 'needs_attention', 'responded'];

function DoctorHome({ user, firstName }) {
  const range = todayRange();
  const today = useQuery({
    queryKey: ['doctor-today', range.from],
    queryFn: () => schedulingApi.doctorSchedule(range.from, range.to),
  });
  const followUps = useQuery({
    queryKey: ['follow-ups', 'doctor', 'open'],
    queryFn: () => followUpApi.forDoctor('open'),
  });
  const patients = useQuery({
    queryKey: ['doctor-patients'],
    queryFn: () => doctorsApi.myPatients(),
  });
  const attention = (followUps.data ?? []).filter((f) => ATTENTION.includes(f.status));
  const requests = (patients.data ?? []).filter((r) => r.status === 'pending');
  const visits = (today.data ?? []).filter((a) => !['cancelled', 'expired'].includes(a.status));

  return (
    <div className="space-y-8">
      <PageHeader
        icon={Activity}
        eyebrow={longDate()}
        title="Today"
        description={`Hello, ${firstName}. Your consultations for today, and patients who need your attention.`}
        actions={
          <ButtonLink as={Link} to="/app/appointments" variant="secondary" icon={CalendarDays}>
            Full schedule
          </ButtonLink>
        }
      />

      <section aria-labelledby="today-heading" className="space-y-3">
        <SectionHeader id="today-heading" icon={CalendarDays} title="Today’s consultations" />
        {today.isPending ? (
          <LoadingState label="Loading today’s schedule" rows={2} />
        ) : visits.length === 0 ? (
          <EmptyState
            compact
            icon={CalendarDays}
            title="No consultations today"
            action={
              <ButtonLink as={Link} to="/app/appointments" variant="secondary" size="sm">
                Check availability
              </ButtonLink>
            }
          >
            Patients book from your availability. Make sure your hours are up to date.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border rounded-2xl border border-border bg-surface-raised">
            {visits.map((a) => (
              <li
                key={a.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className="w-14 shrink-0 text-sm font-semibold tabular-nums text-text">
                    {formatTime(a.startsAt)}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-text">
                      {a.patient?.fullName ?? `Ref ${a.reference}`}
                    </span>
                    <span className="block text-sm text-text-subtle">
                      {MODE_LABELS[a.mode]}
                      {a.clinic && ` · ${a.clinic.name}`}
                    </span>
                  </span>
                  <StatusBadge status={a.status} />
                </div>
                {['confirmed', 'checked_in', 'in_consultation', 'completed'].includes(a.status) && (
                  <ButtonLink
                    as={Link}
                    to={`/app/appointments/${a.id}/consultation`}
                    variant={a.status === 'completed' ? 'subtle' : 'secondary'}
                    size="sm"
                  >
                    {a.status === 'completed' ? 'Summary' : 'Open consultation'}
                  </ButtonLink>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section aria-labelledby="attention-heading" className="space-y-3">
          <SectionHeader
            id="attention-heading"
            icon={HeartPulse}
            title="Follow-ups needing review"
            actions={
              <ButtonLink as={Link} to="/app/follow-ups" variant="subtle" size="sm">
                All follow-ups
              </ButtonLink>
            }
          />
          {followUps.isPending ? (
            <LoadingState label="Loading follow-ups" rows={1} />
          ) : attention.length === 0 ? (
            <EmptyState compact icon={CheckCircle2} title="Nothing needs review">
              Answered check-ins and alerts appear here, urgent first.
            </EmptyState>
          ) : (
            <ul className="space-y-2">
              {attention.slice(0, 5).map((f) => (
                <li key={f.id}>
                  <Link
                    to="/app/follow-ups"
                    className="flex items-center justify-between gap-2 rounded-xl border border-border bg-surface-raised px-4 py-3 hover:border-primary/40"
                  >
                    <span className="font-medium text-text">{f.patientName}</span>
                    <StatusBadge status={f.status} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-labelledby="requests-heading" className="space-y-3">
          <SectionHeader
            id="requests-heading"
            icon={UsersRound}
            title="New patient requests"
            actions={
              <ButtonLink as={Link} to="/app/patients" variant="subtle" size="sm">
                My patients
              </ButtonLink>
            }
          />
          {patients.isPending ? (
            <LoadingState label="Loading requests" rows={1} />
          ) : requests.length === 0 ? (
            <EmptyState compact icon={UsersRound} title="No new requests">
              Patients who ask you to join their care team appear here.
            </EmptyState>
          ) : (
            <Alert
              tone="info"
              title={`${requests.length} patient${requests.length === 1 ? '' : 's'} asked you to join their care team`}
              action={
                <ButtonLink as={Link} to="/app/patients" size="sm">
                  Review requests
                </ButtonLink>
              }
            />
          )}
        </section>
      </div>
      <EmergencyNote />
      <SectionLinks user={user} exclude={['appointments', 'followUps', 'patients']} />
    </div>
  );
}

// ── Clinic admin ─────────────────────────────────────────────────────

function ClinicAdminHome({ user, firstName }) {
  const clinicId = (user.clinicRoles ?? []).find((g) => g.role === 'CLINIC_ADMIN')?.clinicId;
  const range = todayRange();
  const today = useQuery({
    queryKey: ['clinic-today', clinicId, range.from],
    queryFn: () => schedulingApi.clinicSchedule(clinicId, range.from, range.to),
    enabled: Boolean(clinicId),
  });
  const visits = (today.data ?? []).filter((a) => !['cancelled', 'expired'].includes(a.status));
  return (
    <div className="space-y-8">
      <PageHeader
        icon={LayoutDashboard}
        eyebrow={longDate()}
        title="Clinic overview"
        description={`Hello, ${firstName}. Today’s visits at your clinic and the team behind them.`}
        actions={
          <ButtonLink as={Link} to="/app/appointments" variant="secondary" icon={CalendarDays}>
            Clinic schedule
          </ButtonLink>
        }
      />
      <section aria-labelledby="clinic-today" className="space-y-3">
        <SectionHeader id="clinic-today" icon={CalendarDays} title="Today at the clinic" />
        {!clinicId ? (
          <EmptyState compact title="No clinic assigned">
            A platform administrator appoints clinic administrators to a clinic.
          </EmptyState>
        ) : today.isPending ? (
          <LoadingState label="Loading today’s visits" rows={2} />
        ) : visits.length === 0 ? (
          <EmptyState compact icon={CalendarDays} title="No visits today">
            Appointments booked with your clinic’s doctors appear here.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border rounded-2xl border border-border bg-surface-raised">
            {visits.map((a) => (
              <li
                key={a.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <span className="flex items-center gap-3">
                  <span className="w-14 text-sm font-semibold tabular-nums text-text">
                    {formatTime(a.startsAt)}
                  </span>
                  <span>
                    <span className="block font-medium text-text">
                      {a.doctor?.professionalName ?? 'Doctor'}
                    </span>
                    <span className="block text-sm text-text-subtle">{MODE_LABELS[a.mode]}</span>
                  </span>
                </span>
                <StatusBadge status={a.status} />
              </li>
            ))}
          </ul>
        )}
      </section>
      <SectionLinks user={user} exclude={['appointments']} />
    </div>
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
  if (role === 'DOCTOR') return <DoctorHome user={user} firstName={firstName} />;
  if (role === 'CLINIC_ADMIN') return <ClinicAdminHome user={user} firstName={firstName} />;
  if (role === 'PLATFORM_ADMIN') return <AdminHome user={user} firstName={firstName} />;
  if (role === 'SUPPORT') return <SupportHome user={user} firstName={firstName} />;
  return <PatientHome user={user} firstName={firstName} />;
}
