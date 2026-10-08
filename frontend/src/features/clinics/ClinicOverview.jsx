import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  Clock,
  LayoutDashboard,
  Stethoscope,
  UserPlus,
  UsersRound,
} from 'lucide-react';
import { clinicsApi } from '../../lib/domainApi.js';
import { Alert } from '../../components/ui/Alert.jsx';
import { ButtonLink } from '../../components/ui/Button.jsx';
import { Card } from '../../components/ui/Card.jsx';
import { EmptyState, LoadingState } from '../../components/ui/EmptyState.jsx';
import { PageHeader, SectionHeader } from '../../components/ui/Typography.jsx';
import { formatTime } from '../appointments/format.js';
import { ClinicVisitRow, OperationsBoundary } from './ClinicVisits.jsx';
import { ACTIVE, GONE, attentionItems, doctorsWorking, useClinicDay } from './clinicWork.js';
import { LoadError } from '../../components/ui/LoadError.jsx';

function Stat({ label, value, icon: Icon, tone = 'primary' }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-surface-raised px-4 py-3">
      <span
        aria-hidden="true"
        className={`flex h-9 w-9 items-center justify-center rounded-lg ${
          tone === 'warning' ? 'bg-warning/15 text-warning' : 'bg-primary-soft text-primary'
        }`}
      >
        <Icon className="h-4 w-4" />
      </span>
      <span>
        <span className="block text-xl font-semibold tabular-nums text-text">{value}</span>
        <span className="block text-xs text-text-muted">{label}</span>
      </span>
    </div>
  );
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const teamSummary = (members) => {
  const count = (role) =>
    members.filter((m) => m.memberRole === role && m.status === 'active').length;
  return `${plural(count('DOCTOR'), 'active doctor', 'active doctors')} · ${plural(count('CLINIC_ADMIN'), 'administrator', 'administrators')}`;
};

/** Clinic administrator home: today's operations at one clinic. */
export function ClinicOverview({ clinicId, firstName }) {
  const [now] = useState(() => Date.now());
  const clinic = useQuery({
    queryKey: ['clinic', clinicId],
    queryFn: () => clinicsApi.get(clinicId),
    enabled: Boolean(clinicId),
  });
  const members = useQuery({
    queryKey: ['clinic', clinicId, 'members'],
    queryFn: () => clinicsApi.members(clinicId),
    enabled: Boolean(clinicId),
  });
  const day = useClinicDay(clinicId, now);
  const all = [...(day.data ?? [])].sort((x, y) => x.startsAt.localeCompare(y.startsAt));
  const visits = all.filter((a) => !GONE.includes(a.status));
  const issues = attentionItems(all, now);
  const working = doctorsWorking(all);
  const invited = (members.data ?? []).filter(
    (m) => m.memberRole === 'DOCTOR' && m.status === 'invited',
  );
  const date = new Intl.DateTimeFormat('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date(now));

  if (!clinicId) {
    return (
      <EmptyState icon={LayoutDashboard} title="No clinic assigned yet">
        A HealthBridge platform administrator appoints clinic administrators. Once you are
        appointed, your clinic’s schedule and team appear here.
      </EmptyState>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={LayoutDashboard}
        eyebrow={date}
        title={clinic.data?.name ?? 'Clinic overview'}
        description={`Hello, ${firstName}. Today’s visits, the doctors working and anything that needs sorting out.`}
        actions={
          <ButtonLink as={Link} to="/app/appointments" variant="secondary" icon={CalendarDays}>
            Clinic schedule
          </ButtonLink>
        }
      />
      <OperationsBoundary />

      <LoadError queries={[day, clinic, members]} what="today at your clinic" />
      {day.isSuccess && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat icon={CalendarDays} label="Visits today" value={visits.length} />
          <Stat
            icon={Clock}
            label="Still to come"
            value={visits.filter((a) => ACTIVE.includes(a.status)).length}
          />
          <Stat
            icon={CheckCircle2}
            label="Completed"
            value={visits.filter((a) => a.status === 'completed').length}
          />
          <Stat
            icon={AlertTriangle}
            label="Need attention"
            value={issues.length}
            tone={issues.length ? 'warning' : 'primary'}
          />
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-6">
          {issues.length > 0 && (
            <section aria-labelledby="issues-heading" className="space-y-3">
              <SectionHeader id="issues-heading" icon={AlertTriangle} title="Needs attention" />
              <ul className="space-y-2">
                {issues.map((i) => (
                  <li key={i.key}>
                    <Alert tone={i.tone} title={i.title}>
                      {i.detail}
                    </Alert>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section aria-labelledby="today-heading" className="space-y-3">
            <SectionHeader id="today-heading" icon={CalendarDays} title="Today’s appointments" />
            {day.isPending && <LoadingState label="Loading today’s appointments" rows={3} />}
            {day.isSuccess && all.length === 0 && (
              <EmptyState compact icon={CalendarDays} title="No appointments today">
                Appointments booked with your clinic’s doctors appear here as they come in.
              </EmptyState>
            )}
            {all.length > 0 && (
              <ul className="divide-y divide-border rounded-2xl border border-border bg-surface-raised">
                {all.map((a) => (
                  <ClinicVisitRow key={a.id} a={a} now={now} />
                ))}
              </ul>
            )}
          </section>
        </div>

        <aside className="space-y-6" aria-label="Clinic team today">
          <Card>
            <SectionHeader
              icon={Stethoscope}
              title="Doctors working today"
              actions={
                <ButtonLink as={Link} to="/app/clinic" variant="subtle" size="sm">
                  Team
                </ButtonLink>
              }
            />
            {day.isSuccess && working.length === 0 && (
              <p className="mt-3 text-sm text-text-muted">No doctor has visits here today.</p>
            )}
            <ul className="mt-2 divide-y divide-border">
              {working.map((d) => (
                <li key={d.id} className="py-2.5 text-sm">
                  <p className="font-medium text-text">{d.name}</p>
                  <p className="text-text-muted">
                    {formatTime(d.first)}–{formatTime(d.last)} · {d.total} visit
                    {d.total === 1 ? '' : 's'}
                    {d.arrived ? ` · ${d.arrived} checked in` : ''}
                    {d.done ? ` · ${d.done} done` : ''}
                  </p>
                </li>
              ))}
            </ul>
          </Card>
          {invited.length > 0 && (
            <Card>
              <SectionHeader icon={UserPlus} title="Invitations waiting" />
              <ul className="mt-2 space-y-1 text-sm">
                {invited.map((m) => (
                  <li key={m.id} className="text-text">
                    {m.member?.fullName}{' '}
                    <span className="text-text-muted">· waiting for them to accept</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <Card>
            <SectionHeader icon={UsersRound} title="Clinic team" />
            <p className="mt-2 text-sm text-text-muted">
              {members.data ? teamSummary(members.data) : 'Loading…'}
            </p>
            <ButtonLink as={Link} to="/app/clinic" size="sm" variant="secondary" className="mt-3">
              Manage team
            </ButtonLink>
          </Card>
        </aside>
      </div>
    </div>
  );
}
