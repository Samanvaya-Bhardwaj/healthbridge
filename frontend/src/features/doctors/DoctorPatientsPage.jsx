import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { careApi, doctorsApi } from '../../lib/domainApi.js';
import { authErrorMessage } from '../auth/errorMessages.js';
import { Card } from '../../components/ui/Card.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { StatusBadge } from '../../components/ui/Badge.jsx';
import { Skeleton } from '../../components/ui/Skeleton.jsx';
import { UsersRound } from 'lucide-react';
import { PageHeader } from '../../components/ui/Typography.jsx';
import { controlClass } from '../../components/ui/fieldStyles.js';
import { PersonIdentity } from '../../components/ui/Identity.jsx';
import { useConfirm } from '../../components/ui/useConfirm.jsx';
import { EmptyState, LoadingState } from '../../components/ui/EmptyState.jsx';
import { SectionHeader } from '../../components/ui/Typography.jsx';
import { UserPlus } from 'lucide-react';

const ageFrom = (dob) => {
  if (!dob) return null;
  const birth = new Date(dob);
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  if (now < new Date(now.getFullYear(), birth.getMonth(), birth.getDate())) age -= 1;
  return age;
};

function InvitePatient({ onDone }) {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState(null);
  const invite = useMutation({
    mutationFn: () => careApi.invite({ email }),
    onSuccess: (result) => {
      setMessage({ tone: 'success', text: result.message });
      setEmail('');
      onDone();
    },
    onError: (error) => setMessage({ tone: 'error', text: authErrorMessage(error) }),
  });
  return (
    <Card>
      <h2 className="text-base font-semibold text-text">Invite an existing patient</h2>
      <p className="mt-1 text-sm text-text-muted">
        The patient decides whether to accept. You get access only after they accept.
      </p>
      <form
        className="mt-4 flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          invite.mutate();
        }}
      >
        <label htmlFor="invite-email" className="sr-only">
          Patient email
        </label>
        <input
          id="invite-email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="patient@example.com"
          className={`${controlClass(false, { inline: true })} flex-1`}
        />
        <Button type="submit" variant="secondary" disabled={invite.isPending}>
          Send invitation
        </Button>
      </form>
      {message && (
        <Alert tone={message.tone} className="mt-4">
          {message.text}
        </Alert>
      )}
    </Card>
  );
}

export function DoctorPatientsPage() {
  const queryClient = useQueryClient();
  const patients = useQuery({
    queryKey: ['doctors', 'patients'],
    queryFn: () => doctorsApi.myPatients(),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['doctors', 'patients'] });
  const act = useMutation({
    mutationFn: ({ id, action }) => careApi.act(id, action),
    onSuccess: refresh,
  });
  const { confirm, dialog } = useConfirm();
  const confirmEnd = async (r) => {
    const ok = await confirm({
      title: 'End this care relationship?',
      description:
        'You will no longer see this patient’s profile, and they can no longer book with you. The patient can add you again later.',
      confirmLabel: 'End relationship',
      destructive: true,
      tone: 'warning',
    });
    if (ok) act.mutate({ id: r.id, action: 'end' });
  };
  const pending = patients.data?.filter((r) => r.status === 'pending') ?? [];
  const others = patients.data?.filter((r) => r.status !== 'pending') ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        icon={UsersRound}
        eyebrow="Patients"
        title="My Patients"
        description="Patients who chose you as their doctor. Accept new requests to join their care team; you see their records only when they share them with you."
      />
      {act.isError && <Alert tone="error">{authErrorMessage(act.error)}</Alert>}
      {patients.isError && <Alert tone="error">{authErrorMessage(patients.error)}</Alert>}
      {dialog}
      {patients.isPending && <LoadingState label="Loading patients" rows={2} />}
      {pending.length > 0 && (
        <Card>
          <SectionHeader
            icon={UserPlus}
            title="Requests"
            description="These patients asked you to join their care team."
          />
          <ul className="mt-4 divide-y divide-border">
            {pending.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <PersonIdentity name={r.patient.displayName} tone="neutral" />
                <div className="flex gap-2">
                  <Button onClick={() => act.mutate({ id: r.id, action: 'accept' })}>Accept</Button>
                  <Button
                    variant="secondary"
                    onClick={() => act.mutate({ id: r.id, action: 'decline' })}
                  >
                    Decline
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {patients.data && (
        <Card>
          <SectionHeader icon={UsersRound} title="My patients" />
          {others.length === 0 && (
            <div className="mt-3">
              <EmptyState compact icon={UsersRound} title="No patients yet">
                Patients add you from their My Doctors page, or you can invite a patient who already
                uses HealthBridge by email (below).
              </EmptyState>
            </div>
          )}
          <ul className="mt-4 divide-y divide-border">
            {others.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <PersonIdentity
                    name={r.patient.fullName ?? r.patient.displayName ?? 'Invited patient'}
                    detail={
                      r.patient.dateOfBirth ? `Age ${ageFrom(r.patient.dateOfBirth)}` : undefined
                    }
                    tone="neutral"
                  />
                  <StatusBadge status={r.status} />
                </div>
                {r.status === 'invited' && (
                  <Button
                    variant="ghost"
                    onClick={() => act.mutate({ id: r.id, action: 'withdraw' })}
                  >
                    Withdraw invitation
                  </Button>
                )}
                {['active', 'paused'].includes(r.status) && (
                  <Button variant="ghost" onClick={() => confirmEnd(r)}>
                    End relationship
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
      <InvitePatient onDone={refresh} />
    </div>
  );
}
