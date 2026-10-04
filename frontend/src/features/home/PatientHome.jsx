import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  BadgeCheck,
  Bell,
  Building2,
  CalendarDays,
  CalendarPlus,
  CheckCircle2,
  Circle,
  CreditCard,
  FileText,
  HeartPulse,
  History,
  Phone,
  Pill,
  Stethoscope,
  Upload,
  UserRound,
  Video,
} from 'lucide-react';
import { ApiError } from '../../lib/apiClient.js';
import {
  careApi,
  consultationApi,
  followUpApi,
  patientsApi,
  recordsApi,
  schedulingApi,
  timelineApi,
} from '../../lib/domainApi.js';
import { Card } from '../../components/ui/Card.jsx';
import { StatusBadge } from '../../components/ui/Badge.jsx';
import { ButtonLink } from '../../components/ui/Button.jsx';
import { EmptyState, LoadingState } from '../../components/ui/EmptyState.jsx';
import { PersonIdentity } from '../../components/ui/Identity.jsx';
import { PageHeader, SectionHeader } from '../../components/ui/Typography.jsx';
import {
  MODE_LABELS,
  formatDateTime,
  formatDay,
  formatFee,
  formatTime,
} from '../appointments/format.js';

const greeting = (now) => {
  const h = new Date(now).getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
};

/** "Today", "Tomorrow", "In 3 days" (calendar days, viewer's time zone). */
function relativeDay(iso, now) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const day = new Date(iso);
  day.setHours(0, 0, 0, 0);
  const diff = Math.round((day - start) / 86_400_000);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  return `In ${diff} days`;
}

function Step({ done, title, children, action }) {
  return (
    <li className="flex flex-wrap items-start gap-3 py-3 sm:flex-nowrap">
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

/** First visit: the three steps to a first consultation, one clear action at a time. */
function GettingStarted({ hasProfile, hasDoctor, hasPendingDoctor }) {
  return (
    <section
      aria-labelledby="start-heading"
      className="rounded-2xl border border-primary/30 bg-primary-soft p-5 sm:p-6"
    >
      <h2 id="start-heading" className="text-lg font-semibold text-text">
        Get ready for your first consultation
      </h2>
      <p className="mt-1 text-sm text-text-muted">Three steps. It takes about five minutes.</p>
      <ol className="mt-2 divide-y divide-primary/15">
        <Step
          done={hasProfile}
          title="1. Create your health profile"
          action={
            <ButtonLink as={Link} to="/app/profile" size="sm" icon={UserRound}>
              Create profile
            </ButtonLink>
          }
        >
          Your name, date of birth and contact details. Only doctors you choose can see them.
        </Step>
        <Step
          done={hasDoctor}
          title="2. Add your doctor"
          action={
            hasProfile &&
            (hasPendingDoctor ? (
              <span className="text-sm text-text-muted">Waiting for the doctor to accept</span>
            ) : (
              <ButtonLink as={Link} to="/app/doctors" size="sm" icon={Stethoscope}>
                Find a doctor
              </ButtonLink>
            ))
          }
        >
          {hasPendingDoctor
            ? 'Your request has been sent. You’ll get a notification when the doctor accepts.'
            : 'Find your family doctor among verified doctors and send a request.'}
        </Step>
        <Step
          done={false}
          title="3. Book a consultation"
          action={
            hasDoctor && (
              <ButtonLink as={Link} to="/app/doctors" size="sm" icon={CalendarPlus}>
                Book
              </ButtonLink>
            )
          }
        >
          Choose online or in-clinic and a time that suits you.
        </Step>
      </ol>
    </section>
  );
}

/** The dominant card: the next appointment and the one thing to do about it. */
function NextAppointment({ a, now }) {
  const opensAt = new Date(a.startsAt).getTime() - 15 * 60_000;
  const action =
    a.status === 'pending_payment'
      ? {
          label: `Pay ${formatFee(a.feePaise)} to confirm`,
          to: `/app/appointments/${a.id}/pay`,
          icon: CreditCard,
        }
      : a.status === 'in_consultation'
        ? { label: 'Join consultation', to: `/app/appointments/${a.id}`, icon: Video }
        : a.mode === 'online' && now >= opensAt
          ? { label: 'Go to waiting room', to: `/app/appointments/${a.id}`, icon: Video }
          : { label: 'View appointment', to: `/app/appointments/${a.id}` };
  const hint =
    a.status === 'pending_payment'
      ? 'Your time is held only briefly. Pay now to confirm it.'
      : a.mode === 'online'
        ? `Join from the appointment page. The waiting room opens at ${formatTime(new Date(opensAt).toISOString())}.`
        : `At ${a.clinic?.name ?? 'the clinic'}. Check in at reception when you arrive.`;
  const ModeIcon = a.mode === 'online' ? Video : Building2;
  return (
    <section
      aria-labelledby="next-heading"
      className="overflow-hidden rounded-2xl border border-primary/30 bg-surface-raised shadow-card"
    >
      <div className="bg-primary px-5 py-4 text-primary-contrast sm:px-6">
        <h2 id="next-heading" className="text-sm font-medium opacity-90">
          Your next appointment
        </h2>
        <p className="mt-1 text-2xl font-semibold">
          {relativeDay(a.startsAt, now)}, {formatTime(a.startsAt)}
        </p>
        <p className="text-sm opacity-90">{formatDay(a.startsAt)}</p>
      </div>
      <div className="space-y-4 px-5 py-5 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <PersonIdentity
            name={a.doctor?.professionalName ?? 'Your doctor'}
            verified
            detail={a.doctor?.primarySpecialization}
          />
          <StatusBadge status={a.status} />
        </div>
        <p className="flex items-start gap-2 text-sm text-text">
          <ModeIcon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <span>
            <span className="font-medium">{MODE_LABELS[a.mode]} consultation.</span> {hint}
          </span>
        </p>
        <div className="flex flex-wrap gap-2">
          <ButtonLink as={Link} to={action.to} icon={action.icon}>
            {action.label}
          </ButtonLink>
        </div>
      </div>
    </section>
  );
}

function NoAppointment({ doctor, patientId }) {
  return (
    <section
      aria-labelledby="next-heading"
      className="rounded-2xl border border-dashed border-primary/40 bg-surface-raised p-5 sm:p-6"
    >
      <div className="flex gap-4">
        <span
          aria-hidden="true"
          className="hidden h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary sm:flex"
        >
          <CalendarDays className="h-5 w-5" />
        </span>
        <div>
          <h2 id="next-heading" className="text-lg font-semibold text-text">
            No upcoming appointment
          </h2>
          <p className="mt-1 text-sm text-text-muted">
            {doctor
              ? `Not feeling well, or due a check-up? Book an online consultation with ${doctor.doctor.professionalName}; they’ll tell you if you need to visit.`
              : 'Add a doctor to your care team first; once they accept, you can book.'}
          </p>
          <div className="mt-4">
            {doctor ? (
              <ButtonLink
                as={Link}
                to={`/app/appointments/book?doctorId=${doctor.doctorId}&patientId=${patientId}`}
                icon={CalendarPlus}
              >
                Book with {doctor.doctor.professionalName}
              </ButtonLink>
            ) : (
              <ButtonLink as={Link} to="/app/doctors" icon={Stethoscope}>
                Find a doctor
              </ButtonLink>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

/** Things only the patient can move forward, most urgent first. */
function ActionsNeeded({ items, loading }) {
  return (
    <section aria-labelledby="actions-heading" className="space-y-3">
      <SectionHeader id="actions-heading" icon={Bell} title="Needs your attention" />
      {loading ? (
        <LoadingState label="Checking for things to do" rows={1} />
      ) : items.length === 0 ? (
        <p className="flex items-center gap-2 rounded-xl border border-border bg-surface-raised px-4 py-3 text-sm text-text-muted">
          <CheckCircle2 aria-hidden="true" className="h-5 w-5 text-success" />
          You’re all set. Nothing needs your attention right now.
        </p>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <li
              key={item.key}
              className={`flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3 ${
                item.urgent ? 'border-danger/50 bg-danger/10' : 'border-warning/40 bg-warning/10'
              }`}
            >
              <item.icon
                aria-hidden="true"
                className={`h-5 w-5 shrink-0 ${item.urgent ? 'text-danger' : 'text-warning'}`}
              />
              <div className="min-w-0 flex-1 text-sm">
                <p className="font-medium text-text">{item.title}</p>
                {item.detail && <p className="text-text-muted">{item.detail}</p>}
              </div>
              {item.href ? (
                <a
                  href={item.href}
                  className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-danger px-4 text-sm font-medium text-white"
                >
                  <Phone aria-hidden="true" className="h-4 w-4" />
                  {item.label}
                </a>
              ) : (
                <ButtonLink as={Link} to={item.to} size="sm" variant="primary">
                  {item.label}
                </ButtonLink>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const TIMELINE_ICONS = {
  appointment: CalendarDays,
  consultation: Stethoscope,
  document: FileText,
  lab_result: HeartPulse,
  prescription: Pill,
  follow_up: HeartPulse,
};

function RecentActivity({ patientId }) {
  const timeline = useQuery({
    queryKey: ['timeline', patientId, 'home'],
    queryFn: () => timelineApi.list(patientId),
    enabled: Boolean(patientId),
    retry: false,
  });
  const events = (timeline.data?.data ?? []).slice(0, 4);
  return (
    <Card>
      <SectionHeader
        icon={History}
        title="Recent health activity"
        actions={
          events.length > 0 && (
            <ButtonLink as={Link} to="/app/timeline" variant="subtle" size="sm">
              Full timeline
            </ButtonLink>
          )
        }
      />
      {timeline.isPending && <LoadingState label="Loading activity" rows={2} className="mt-3" />}
      {timeline.isSuccess && events.length === 0 && (
        <p className="mt-3 text-sm text-text-muted">
          Visits, documents and prescriptions will appear here as they happen.
        </p>
      )}
      {timeline.isError && (
        <p className="mt-3 text-sm text-text-muted">Recent activity can’t be shown right now.</p>
      )}
      <ol className="mt-2 divide-y divide-border">
        {events.map((e) => {
          const Icon = TIMELINE_ICONS[e.type] ?? History;
          return (
            <li key={e.id} className="flex items-start gap-3 py-2.5">
              <Icon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <div className="min-w-0 flex-1 text-sm">
                <p className="text-text">{e.title}</p>
                <p className="flex flex-wrap items-center gap-x-2 text-xs text-text-muted">
                  <time dateTime={e.occurredAt}>{formatDateTime(e.occurredAt)}</time>
                  {e.provenance === 'doctor_verified' && (
                    <span className="inline-flex items-center gap-1 text-success">
                      <BadgeCheck aria-hidden="true" className="h-3.5 w-3.5" />
                      Verified
                    </span>
                  )}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

function DoctorsCard({ team, patientId }) {
  const current = team.filter((r) => ['active', 'pending', 'paused'].includes(r.status));
  return (
    <Card>
      <SectionHeader
        icon={Stethoscope}
        title="My doctors"
        actions={
          <ButtonLink as={Link} to="/app/doctors" variant="subtle" size="sm">
            {current.length ? 'Manage' : 'Find a doctor'}
          </ButtonLink>
        }
      />
      {current.length === 0 ? (
        <p className="mt-3 text-sm text-text-muted">
          No doctors yet. Add your family doctor so you can book with them.
        </p>
      ) : (
        <ul className="mt-2 divide-y divide-border">
          {current.slice(0, 3).map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
              <PersonIdentity
                name={r.doctor.professionalName}
                verified
                size="sm"
                detail={r.doctor.primarySpecialization}
              />
              {r.status === 'active' ? (
                <ButtonLink
                  as={Link}
                  to={`/app/appointments/book?doctorId=${r.doctorId}&patientId=${patientId}`}
                  size="sm"
                  variant="secondary"
                >
                  Book
                </ButtonLink>
              ) : (
                <StatusBadge
                  status={r.status}
                  label={r.status === 'pending' ? 'Request pending' : undefined}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function RecordsCard({ patientId }) {
  const documents = useQuery({
    queryKey: ['documents', patientId],
    queryFn: () => recordsApi.list(patientId),
    retry: false,
  });
  const available = (documents.data ?? []).filter((d) => d.status === 'available');
  const checking = (documents.data ?? []).filter((d) =>
    ['pending_upload', 'quarantined', 'scanning'].includes(d.status),
  ).length;
  return (
    <Card>
      <SectionHeader icon={FileText} title="Health records" />
      <p className="mt-3 text-sm text-text">
        {documents.isPending
          ? 'Loading…'
          : available.length
            ? `${available.length} document${available.length === 1 ? '' : 's'} in your records.`
            : 'No documents yet.'}
        {checking > 0 && ` ${checking} being checked.`}
      </p>
      <p className="mt-1 text-sm text-text-muted">
        Keep lab reports and scans here so your doctors can see your history when you share it.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <ButtonLink as={Link} to="/app/records" size="sm" variant="secondary" icon={Upload}>
          {available.length ? 'Open records' : 'Upload a document'}
        </ButtonLink>
      </div>
    </Card>
  );
}

function PrescriptionsCard({ patientId }) {
  const list = useQuery({
    queryKey: ['prescriptions', patientId],
    queryFn: () => consultationApi.forPatient(patientId),
    retry: false,
  });
  const latest = (list.data ?? []).find((rx) => rx.status === 'signed');
  return (
    <Card>
      <SectionHeader icon={Pill} title="Prescriptions" />
      <p className="mt-3 text-sm text-text">
        {list.isPending
          ? 'Loading…'
          : latest
            ? `Latest: ${latest.reference}${latest.doctorName ? ` from ${latest.doctorName}` : ''}, signed ${formatDateTime(latest.signedAt)}.`
            : 'No prescriptions yet.'}
      </p>
      <p className="mt-1 text-sm text-text-muted">
        Prescriptions your doctors sign appear here, ready to download.
      </p>
      <div className="mt-3">
        <ButtonLink as={Link} to="/app/prescriptions" size="sm" variant="secondary" icon={Pill}>
          {latest ? 'View prescriptions' : 'Open prescriptions'}
        </ButtonLink>
      </div>
    </Card>
  );
}

/**
 * Patient home, ordered by what matters now: the next appointment, things that need the
 * patient, recent activity, then their doctors, records and prescriptions.
 */
export function PatientHome({ firstName }) {
  const [now] = useState(() => Date.now());
  const profile = useQuery({ queryKey: ['patients', 'me'], queryFn: patientsApi.me, retry: false });
  const patientId = profile.data?.id;
  const missing = profile.error instanceof ApiError && profile.error.status === 404;
  const care = useQuery({
    queryKey: ['care', patientId],
    queryFn: () => careApi.list(),
    enabled: Boolean(patientId),
  });
  const upcoming = useQuery({
    queryKey: ['appointments', undefined, 'upcoming'],
    queryFn: () => schedulingApi.mine({ scope: 'upcoming' }),
    enabled: Boolean(patientId),
  });
  const followUps = useQuery({
    queryKey: ['follow-ups', patientId],
    queryFn: () => followUpApi.forPatient(patientId),
    enabled: Boolean(patientId),
    retry: false,
  });

  const team = care.data ?? [];
  const activeDoctor = team.find((r) => r.status === 'active');
  const hasPendingDoctor = team.some((r) => r.status === 'pending');
  const appointments = [...(upcoming.data ?? [])].sort((a, b) =>
    a.startsAt.localeCompare(b.startsAt),
  );
  const next = appointments[0];

  const actions = [
    ...(followUps.data ?? [])
      .filter((f) => f.status === 'urgent')
      .map((f) => ({
        key: `urgent-${f.id}`,
        urgent: true,
        icon: AlertTriangle,
        title: 'You reported a warning sign',
        detail: `In your check-in for ${f.doctorName}. If you haven’t already, call 112 or go to the nearest emergency department.`,
        label: 'Call 112',
        href: 'tel:112',
      })),
    ...(followUps.data ?? [])
      .filter((f) => f.status === 'awaiting_response')
      .map((f) => ({
        key: `fu-${f.id}`,
        icon: HeartPulse,
        title: `${f.doctorName} asked how you are`,
        detail: 'A short check-in after your consultation: three quick questions.',
        label: 'Answer',
        to: '/app/follow-ups',
      })),
    ...appointments
      .filter((a) => a.status === 'pending_payment')
      .map((a) => ({
        key: `pay-${a.id}`,
        icon: CreditCard,
        title: `Pay ${formatFee(a.feePaise)} to confirm your appointment`,
        detail: `${formatDateTime(a.startsAt)} with ${a.doctor?.professionalName ?? 'your doctor'}. Unpaid bookings are released.`,
        label: 'Pay now',
        to: `/app/appointments/${a.id}/pay`,
      })),
    ...team
      .filter((r) => r.status === 'invited')
      .map((r) => ({
        key: `inv-${r.id}`,
        icon: Stethoscope,
        title: `${r.doctor.professionalName} invited you to their care`,
        detail: 'Accept to book with them, or decline. Nothing is shared unless you accept.',
        label: 'Review',
        to: '/app/doctors',
      })),
  ];

  const loading = profile.isPending || (patientId && (care.isPending || upcoming.isPending));
  const firstRun = missing || (!loading && !next && !activeDoctor);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={greeting(now)}
        title={`Welcome, ${firstName}`}
        description={
          next
            ? 'Here’s what’s next for your care.'
            : 'Stay in touch with the doctors you trust. Consult online first; visit only when your doctor says you need to.'
        }
      />

      {loading ? (
        <LoadingState label="Loading your home page" rows={3} />
      ) : (
        <>
          {firstRun && !next ? (
            <GettingStarted
              hasProfile={Boolean(patientId)}
              hasDoctor={Boolean(activeDoctor)}
              hasPendingDoctor={hasPendingDoctor}
            />
          ) : next ? (
            <NextAppointment a={next} now={now} />
          ) : (
            <NoAppointment doctor={activeDoctor} patientId={patientId} />
          )}

          {patientId && (!firstRun || actions.length > 0) && (
            <ActionsNeeded items={actions} loading={followUps.isPending} />
          )}

          {patientId && appointments.length > 1 && (
            <section aria-labelledby="later-heading" className="space-y-3">
              <SectionHeader
                id="later-heading"
                icon={CalendarDays}
                title="Later appointments"
                actions={
                  <ButtonLink as={Link} to="/app/appointments" variant="subtle" size="sm">
                    All appointments
                  </ButtonLink>
                }
              />
              <ul className="space-y-2">
                {appointments.slice(1, 4).map((a) => (
                  <li key={a.id}>
                    <Link
                      to={`/app/appointments/${a.id}`}
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
            </section>
          )}

          {patientId && !firstRun && (
            <div className="grid gap-4 lg:grid-cols-2">
              <RecentActivity patientId={patientId} />
              <DoctorsCard team={team} patientId={patientId} />
              <RecordsCard patientId={patientId} />
              <PrescriptionsCard patientId={patientId} />
            </div>
          )}
          {missing && (
            <EmptyState compact icon={UserRound} title="Your records will appear here">
              Once you create your health profile, your appointments, documents and prescriptions
              are shown on this page.
            </EmptyState>
          )}
        </>
      )}

      <p className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-text">
        <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <span>
          <span className="font-medium">In a medical emergency</span>, call 112 or 108, or go to the
          nearest emergency department. Don’t wait for an online consultation.
        </span>
      </p>
    </div>
  );
}
