import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Search, ShieldCheck, Stethoscope, UserPlus, UsersRound } from 'lucide-react';
import { useAuth } from '../auth/authContext.js';
import { clinicsApi, doctorsApi, schedulingApi } from '../../lib/domainApi.js';
import { authErrorMessage } from '../auth/errorMessages.js';
import { Card } from '../../components/ui/Card.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { Badge, StatusBadge } from '../../components/ui/Badge.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { EmptyState, LoadingState } from '../../components/ui/EmptyState.jsx';
import { PersonIdentity } from '../../components/ui/Identity.jsx';
import { PageHeader, SectionHeader } from '../../components/ui/Typography.jsx';
import { controlClass } from '../../components/ui/fieldStyles.js';
import { useConfirm } from '../../components/ui/useConfirm.jsx';
import { formatDateTime, formatFullDate } from '../appointments/format.js';
import { OperationsBoundary } from './ClinicVisits.jsx';
import { ACTIVE, DAY_MS, adminClinicIds, dayStart } from './clinicWork.js';
import { useSafeMutation } from '../../lib/useSafeMutation.js';

const MEMBER_STATES = {
  invited: {
    label: 'Invited',
    help: 'Waiting for the doctor to accept from their Professional profile.',
  },
  active: { label: 'Active', help: null },
  declined: { label: 'Declined', help: 'The doctor declined the invitation.' },
};
const STEPS = [
  ['Invite', 'Search for a verified doctor and invite them.'],
  ['Doctor accepts', 'They accept from their Professional profile.'],
  ['Active', 'They can publish in-clinic hours here and patients can book them.'],
  ['Ended', 'No new in-clinic hours here. Appointments already booked are not cancelled.'],
];

function ClinicDetails({ clinic }) {
  const c = clinic.data;
  const rows = c
    ? [
        ['Address', [c.addressLine, c.city, c.state, c.postalCode].filter(Boolean).join(', ')],
        ['Phone', c.phone],
        ['Email', c.email],
        ['Registration number', c.registrationNumber],
      ]
    : [];
  return (
    <Card>
      <SectionHeader
        icon={Building2}
        title="Clinic details"
        description="Shown to patients for in-clinic visits. To change them, contact HealthBridge: clinic details are maintained by platform administrators."
      />
      {clinic.isPending && <LoadingState label="Loading clinic" rows={1} className="mt-3" />}
      {clinic.isError && (
        <Alert tone="error" className="mt-3">
          {authErrorMessage(clinic.error)}
        </Alert>
      )}
      {c && (
        <dl className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-text-muted">Name</dt>
            <dd className="flex flex-wrap items-center gap-2 font-medium text-text">
              {c.name} <StatusBadge status={c.status} />
            </dd>
          </div>
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt className="text-text-muted">{label}</dt>
              <dd className="font-medium text-text">{value || 'Not provided'}</dd>
            </div>
          ))}
        </dl>
      )}
    </Card>
  );
}

function PractisingDoctors({ clinicId }) {
  const [range] = useState(() => {
    const from = dayStart(new Date());
    return { from: from.toISOString(), to: new Date(from.getTime() + 7 * DAY_MS).toISOString() };
  });
  const doctors = useQuery({
    queryKey: ['doctors', 'directory', 'clinic', clinicId],
    queryFn: async () => (await doctorsApi.directory({ clinicId, limit: 50 })).data,
  });
  const week = useQuery({
    queryKey: ['clinic-board', clinicId, 'week', range.from],
    queryFn: () => schedulingApi.clinicSchedule(clinicId, range.from, range.to),
  });
  return (
    <Card>
      <SectionHeader
        icon={Stethoscope}
        title="Doctors practising here"
        description="Verified doctors with an active membership. Patients can book them for in-clinic visits at this clinic."
      />
      {doctors.isPending && <LoadingState label="Loading doctors" rows={2} className="mt-3" />}
      {doctors.isError && (
        <Alert tone="error" className="mt-3">
          {authErrorMessage(doctors.error)}
        </Alert>
      )}
      {doctors.data?.length === 0 && (
        <div className="mt-3">
          <EmptyState compact icon={Stethoscope} title="No doctors practising here yet">
            Invite a verified doctor below. They appear here once they accept.
          </EmptyState>
        </div>
      )}
      <ul className="mt-2 divide-y divide-border">
        {doctors.data?.map((d) => {
          const visits = (week.data ?? [])
            .filter((a) => a.doctorId === d.id && ACTIVE.includes(a.status))
            .sort((x, y) => x.startsAt.localeCompare(y.startsAt));
          return (
            <li key={d.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
              <PersonIdentity
                name={d.professionalName}
                verified
                detail={`${d.primarySpecialization} · ${d.yearsOfExperience} yrs`}
              />
              <div className="text-sm sm:text-right">
                <p className="flex flex-wrap gap-1.5 sm:justify-end">
                  <Badge tone="primary" icon={ShieldCheck}>
                    Verified
                  </Badge>
                  <Badge>In clinic here</Badge>
                </p>
                <p className="mt-1 text-text-muted">
                  {week.isPending
                    ? '…'
                    : week.isError
                      ? 'Visits couldn’t be loaded just now'
                      : visits.length
                        ? `${visits.length} visit${visits.length === 1 ? '' : 's'} in the next 7 days · next ${formatDateTime(visits[0].startsAt)}`
                        : 'No visits booked in the next 7 days'}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-xs text-text-subtle">
        A doctor’s published hours belong to the doctor; here you see their booked visits at this
        clinic. A doctor whose registration is no longer verified drops off this list.
      </p>
    </Card>
  );
}

function Membership({ clinicId, members, onChanged }) {
  const { user } = useAuth();
  const end = useSafeMutation({
    mutationFn: (id) => clinicsApi.endMembership(clinicId, id),
    onSuccess: onChanged,
  });
  const { confirm, dialog } = useConfirm();
  const onEnd = async (m) => {
    const name = m.member?.fullName ?? 'this member';
    const self = m.userId === user.id;
    const ok = await confirm(
      m.status === 'invited'
        ? {
            title: `Withdraw the invitation to ${name}?`,
            description: 'They will no longer be able to accept it. You can invite them again.',
            confirmLabel: 'Withdraw invitation',
            destructive: true,
          }
        : m.memberRole === 'DOCTOR'
          ? {
              title: `End ${name}’s membership?`,
              description:
                'They can no longer publish in-clinic hours at this clinic. Appointments already booked here are not cancelled; cancel them from the clinic schedule if needed.',
              confirmLabel: 'End membership',
              destructive: true,
              tone: 'warning',
            }
          : {
              title: self
                ? 'Remove yourself as an administrator?'
                : `Remove ${name} as an administrator?`,
              description: `${
                self ? 'You lose' : 'They lose'
              } access to this clinic’s schedule and team at once. A clinic always keeps at least one administrator.`,
              confirmLabel: 'Remove administrator',
              destructive: true,
              tone: 'warning',
            },
    );
    if (ok) end.mutate(m.id);
  };
  const groups = [
    ['DOCTOR', 'Doctors'],
    ['CLINIC_ADMIN', 'Administrators'],
  ];
  return (
    <Card>
      {dialog}
      <SectionHeader
        icon={UsersRound}
        title="Membership"
        description="Who belongs to this clinic, and in what role."
      />
      <ol className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {STEPS.map(([title, text], i) => (
          <li key={title} className="rounded-lg bg-surface-muted p-3 text-sm">
            <p className="font-medium text-text">
              {i + 1}. {title}
            </p>
            <p className="mt-1 text-text-muted">{text}</p>
          </li>
        ))}
      </ol>
      {end.isError && (
        <Alert tone="error" className="mt-4">
          {authErrorMessage(end.error)}
        </Alert>
      )}
      {members.isPending && <LoadingState label="Loading members" rows={2} className="mt-4" />}
      {members.isError && (
        <Alert tone="error" className="mt-4">
          {authErrorMessage(members.error)}
        </Alert>
      )}
      {groups.map(([role, title]) => {
        const list = (members.data ?? []).filter((m) => m.memberRole === role);
        if (!list.length) return null;
        return (
          <section key={role} className="mt-5" aria-label={title}>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-text-subtle">
              {title} ({list.length})
            </h3>
            <ul className="mt-1 divide-y divide-border">
              {list.map((m) => {
                const state = MEMBER_STATES[m.status];
                return (
                  <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-text">
                        {m.member?.fullName}
                        {m.userId === user.id && <Badge>You</Badge>}
                        <StatusBadge status={m.status} label={state?.label} />
                      </p>
                      <p className="text-xs text-text-subtle">
                        {m.member?.email}
                        {m.joinedAt &&
                          m.status === 'active' &&
                          ` · member since ${formatFullDate(m.joinedAt)}`}
                      </p>
                      {state?.help && (
                        <p className="mt-0.5 text-xs text-text-muted">{state.help}</p>
                      )}
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onEnd(m)}
                      disabled={end.isPending}
                    >
                      {m.status === 'invited'
                        ? 'Withdraw invitation'
                        : role === 'DOCTOR'
                          ? 'End membership'
                          : 'Remove'}
                    </Button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </Card>
  );
}

function InviteDoctor({ clinicId, onInvited }) {
  const [q, setQ] = useState('');
  const [message, setMessage] = useState(null);
  const search = useSafeMutation({
    mutationFn: async () => (await doctorsApi.directory({ q })).data,
  });
  const invite = useSafeMutation({
    mutationFn: (doctor) => clinicsApi.inviteDoctor(clinicId, doctor.id),
    onSuccess: (_m, doctor) => {
      setMessage({
        tone: 'success',
        text: `Invitation sent to ${doctor.professionalName}. They accept from their Professional profile; until then they are listed as Invited.`,
      });
      onInvited();
    },
    onError: (e) => setMessage({ tone: 'error', text: authErrorMessage(e) }),
  });
  return (
    <Card>
      <SectionHeader
        icon={UserPlus}
        title="Invite a doctor"
        description="Only doctors whose registration HealthBridge has verified can be invited."
      />
      <form
        role="search"
        className="mt-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setMessage(null);
          if (q.trim().length >= 2) search.mutate();
        }}
      >
        <label className="sr-only" htmlFor={`doc-${clinicId}`}>
          Doctor name or speciality
        </label>
        <input
          id={`doc-${clinicId}`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Doctor name or speciality"
          className={`${controlClass(false, { inline: true })} min-w-0 flex-1`}
        />
        <Button type="submit" variant="secondary" icon={Search} loading={search.isPending}>
          Search
        </Button>
      </form>
      {message && (
        <Alert tone={message.tone} className="mt-3">
          {message.text}
        </Alert>
      )}
      {search.data?.length === 0 && (
        <p className="mt-3 text-sm text-text-muted">No verified doctors match that search.</p>
      )}
      <ul className="mt-3 divide-y divide-border">
        {search.data?.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <PersonIdentity
              name={d.professionalName}
              verified
              size="sm"
              detail={`${d.primarySpecialization}${
                d.clinics.length ? ` · ${d.clinics.map((c) => c.name).join(', ')}` : ''
              }`}
            />
            {d.clinics.some((c) => c.id === clinicId) ? (
              <span className="text-xs text-text-subtle">Already practising here</span>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                icon={UserPlus}
                onClick={() => invite.mutate(d)}
                disabled={invite.isPending}
              >
                Invite
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ClinicTeam({ clinicId }) {
  const queryClient = useQueryClient();
  const clinic = useQuery({
    queryKey: ['clinic', clinicId],
    queryFn: () => clinicsApi.get(clinicId),
  });
  const members = useQuery({
    queryKey: ['clinic', clinicId, 'members'],
    queryFn: () => clinicsApi.members(clinicId),
  });
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['clinic', clinicId, 'members'] });
    queryClient.invalidateQueries({ queryKey: ['doctors', 'directory'] });
  };
  return (
    <div className="space-y-6">
      <ClinicDetails clinic={clinic} />
      <PractisingDoctors clinicId={clinicId} />
      <Membership clinicId={clinicId} members={members} onChanged={refresh} />
      <InviteDoctor clinicId={clinicId} onInvited={refresh} />
    </div>
  );
}

/** Clinic administrators: clinic details, doctors and membership (clinic-scoped). */
export function ClinicPage() {
  const { user } = useAuth();
  const clinicIds = adminClinicIds(user);
  return (
    <div className="space-y-6">
      <PageHeader
        icon={Building2}
        eyebrow="Clinic"
        title="Doctors & team"
        description="Your clinic’s details, the doctors practising here and who belongs to the clinic. Clinic membership never gives access to patient records."
      />
      <OperationsBoundary compact />
      {clinicIds.length === 0 && (
        <EmptyState icon={Building2} title="No clinic assigned yet">
          A HealthBridge platform administrator appoints clinic administrators to a clinic.
        </EmptyState>
      )}
      {clinicIds.map((id) => (
        <ClinicTeam key={id} clinicId={id} />
      ))}
    </div>
  );
}
