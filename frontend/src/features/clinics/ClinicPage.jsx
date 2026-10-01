import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/authContext.js';
import { clinicsApi, doctorsApi } from '../../lib/domainApi.js';
import { authErrorMessage } from '../auth/errorMessages.js';
import { Card } from '../../components/ui/Card.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { StatusBadge } from '../../components/ui/Badge.jsx';
import { Skeleton } from '../../components/ui/Skeleton.jsx';

const ROLE_LABEL = { CLINIC_ADMIN: 'Administrator', DOCTOR: 'Doctor' };

function InviteDoctor({ clinicId, memberUserIds, onInvited }) {
  const [q, setQ] = useState('');
  const [error, setError] = useState(null);
  const search = useMutation({ mutationFn: async () => (await doctorsApi.directory({ q })).data });
  const invite = useMutation({
    mutationFn: (doctorId) => clinicsApi.inviteDoctor(clinicId, doctorId),
    onSuccess: onInvited,
    onError: (e) => setError(authErrorMessage(e)),
  });
  return (
    <div className="mt-6 border-t border-border pt-6">
      <h3 className="text-sm font-semibold text-text">Invite a verified doctor</h3>
      <form
        className="mt-3 flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim().length >= 2) search.mutate();
        }}
      >
        <label className="sr-only" htmlFor={`doc-${clinicId}`}>
          Search doctors
        </label>
        <input
          id={`doc-${clinicId}`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Doctor name or specialty"
          className="min-h-11 flex-1 rounded-lg border border-border bg-surface-raised px-3.5"
        />
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </form>
      {error && (
        <Alert tone="error" className="mt-3">
          {error}
        </Alert>
      )}
      <ul className="mt-3 divide-y divide-border">
        {search.data?.map((d) => (
          <li key={d.id} className="flex items-center justify-between gap-3 py-2 text-sm">
            <span>
              {d.professionalName}{' '}
              <span className="text-text-subtle">· {d.primarySpecialization}</span>
            </span>
            {d.clinics.some((c) => c.id === clinicId) || memberUserIds.has(d.id) ? (
              <span className="text-xs text-text-subtle">Already a member</span>
            ) : (
              <Button
                variant="ghost"
                onClick={() => invite.mutate(d.id)}
                disabled={invite.isPending}
              >
                Invite
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ClinicCard({ clinicId }) {
  const queryClient = useQueryClient();
  const clinic = useQuery({
    queryKey: ['clinic', clinicId],
    queryFn: () => clinicsApi.get(clinicId),
  });
  const members = useQuery({
    queryKey: ['clinic', clinicId, 'members'],
    queryFn: () => clinicsApi.members(clinicId),
  });
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ['clinic', clinicId, 'members'] });
  const end = useMutation({
    mutationFn: (id) => clinicsApi.endMembership(clinicId, id),
    onSuccess: refresh,
  });

  return (
    <Card>
      {clinic.isPending ? (
        <Skeleton className="h-6 w-48" />
      ) : (
        <h2 className="text-base font-semibold text-text">
          {clinic.data?.name}{' '}
          {clinic.data?.city && (
            <span className="font-normal text-text-subtle">· {clinic.data.city}</span>
          )}
        </h2>
      )}
      {end.isError && (
        <Alert tone="error" className="mt-4">
          {authErrorMessage(end.error)}
        </Alert>
      )}
      <ul className="mt-4 divide-y divide-border">
        {members.data?.map((m) => (
          <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div>
              <p className="flex items-center gap-2 text-sm font-medium text-text">
                {m.member.fullName} <StatusBadge status={m.status} />
              </p>
              <p className="text-xs text-text-subtle">
                {ROLE_LABEL[m.memberRole]} · {m.member.email}
              </p>
            </div>
            <Button
              variant="ghost"
              onClick={() => end.mutate(m.id)}
              aria-label={`Remove ${m.member.fullName}`}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
      <InviteDoctor clinicId={clinicId} memberUserIds={new Set()} onInvited={refresh} />
    </Card>
  );
}

/** Clinic administrators: the clinics they administer (clinic-scoped). */
export function ClinicPage() {
  const { user } = useAuth();
  const clinicIds = [
    ...new Set(user.clinicRoles.filter((g) => g.role === 'CLINIC_ADMIN').map((g) => g.clinicId)),
  ];
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-text">Clinic</h1>
        <p className="mt-2 text-text-muted">
          Doctors and administrators at your clinic. Clinic membership never grants access to
          patient records.
        </p>
      </div>
      {clinicIds.map((id) => (
        <ClinicCard key={id} clinicId={id} />
      ))}
    </div>
  );
}
