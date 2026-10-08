import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Plus, Power, Search, UserCog, UsersRound } from 'lucide-react';
import { ROLE_LABELS } from '@healthbridge/shared';
import { adminApi, clinicsApi } from '../../lib/domainApi.js';
import { applyFieldErrors, authErrorMessage } from '../auth/errorMessages.js';
import { Card } from '../../components/ui/Card.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { StatusBadge } from '../../components/ui/Badge.jsx';
import { EmptyState, LoadingState } from '../../components/ui/EmptyState.jsx';
import { TextField } from '../../components/ui/Fields.jsx';
import { PageHeader, SectionHeader } from '../../components/ui/Typography.jsx';
import { controlClass } from '../../components/ui/fieldStyles.js';
import { useConfirm } from '../../components/ui/useConfirm.jsx';
import { PlatformBoundary } from './AdminParts.jsx';
import { useSafeMutation } from '../../lib/useSafeMutation.js';
import { formatFullDate } from '../appointments/format.js';

const EMPTY = {
  name: '',
  city: '',
  state: '',
  postalCode: '',
  addressLine: '',
  phone: '',
  email: '',
  registrationNumber: '',
};
const FIELDS = [
  ['name', 'Clinic name', { required: true }],
  ['city', 'City'],
  ['state', 'State'],
  ['postalCode', 'PIN code'],
  ['addressLine', 'Address'],
  ['phone', 'Phone', { placeholder: '+91…' }],
  ['email', 'Email', { type: 'email' }],
  ['registrationNumber', 'Registration number'],
];

function CreateClinic({ onCreated }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [message, setMessage] = useState(null);
  const create = useSafeMutation({
    mutationFn: () =>
      adminApi.createClinic(
        Object.fromEntries(Object.entries(form).filter(([, v]) => v.trim() !== '')),
      ),
    onSuccess: (clinic) => {
      setMessage({
        tone: 'success',
        text: `${clinic.name} was created. Appoint its administrator next.`,
      });
      setForm(EMPTY);
      setOpen(false);
      onCreated();
    },
    onError: (err) => {
      const fieldErrors = {};
      if (!applyFieldErrors(err, (name, e) => (fieldErrors[name] = e.message))) {
        setMessage({ tone: 'error', text: authErrorMessage(err) });
      }
      setErrors(fieldErrors);
    },
  });
  return (
    <Card>
      <SectionHeader
        icon={Plus}
        title="New clinic"
        description="A new clinic starts active. Appoint its administrator after creating it; they manage the clinic’s team and schedule."
        actions={
          !open && (
            <Button variant="secondary" icon={Plus} onClick={() => setOpen(true)}>
              Add a clinic
            </Button>
          )
        }
      />
      {message && (
        <Alert tone={message.tone} className="mt-4">
          {message.text}
        </Alert>
      )}
      {open && (
        <form
          className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            setMessage(null);
            setErrors({});
            create.mutate();
          }}
        >
          {FIELDS.map(([key, label, props = {}]) => (
            <TextField
              key={key}
              label={label}
              optional={!props.required}
              value={form[key]}
              error={errors[key]}
              onChange={(e) => setForm({ ...form, [key]: e.target.value })}
              {...props}
            />
          ))}
          <div className="flex gap-2 sm:col-span-2">
            <Button type="submit" loading={create.isPending}>
              Create clinic
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}

function Members({ clinicId }) {
  const members = useQuery({
    queryKey: ['clinic', clinicId, 'members'],
    queryFn: () => clinicsApi.members(clinicId),
  });
  if (members.isPending) return <LoadingState label="Loading members" rows={1} />;
  if (members.isError) return <Alert tone="error">{authErrorMessage(members.error)}</Alert>;
  if (!members.data.length) {
    return <p className="text-sm text-text-muted">No members yet. Appoint an administrator.</p>;
  }
  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {members.data.map((m) => (
        <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
          <span className="text-sm">
            <span className="font-medium text-text">{m.member?.fullName}</span>{' '}
            <span className="text-text-muted">
              · {ROLE_LABELS[m.memberRole] ?? m.memberRole} · {m.member?.email}
            </span>
          </span>
          <StatusBadge status={m.status} />
        </li>
      ))}
    </ul>
  );
}

function AppointAdmin({ clinic, onAppointed }) {
  const [q, setQ] = useState('');
  const [message, setMessage] = useState(null);
  const { confirm, dialog } = useConfirm();
  const users = useSafeMutation({ mutationFn: () => adminApi.findUsers(q) });
  const appoint = useSafeMutation({
    mutationFn: (user) => adminApi.appointClinicAdmin(clinic.id, user.id),
    onSuccess: (_d, user) => {
      setMessage({
        tone: 'success',
        text: `${user.fullName} is now an administrator of ${clinic.name}. They see it the next time they sign in.`,
      });
      onAppointed();
    },
    onError: (error) => setMessage({ tone: 'error', text: authErrorMessage(error) }),
  });
  const choose = async (user) => {
    const ok = await confirm({
      title: `Appoint ${user.fullName}?`,
      description: `They will manage ${clinic.name}: its schedule, check-ins, refunds and team. Clinic administrators never see patients’ medical records.`,
      confirmLabel: 'Appoint administrator',
    });
    if (ok) appoint.mutate(user);
  };
  return (
    <div className="space-y-3">
      {dialog}
      <form
        role="search"
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim().length >= 2) users.mutate();
        }}
      >
        <label className="sr-only" htmlFor={`find-${clinic.id}`}>
          Find user by name or email
        </label>
        <input
          id={`find-${clinic.id}`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Find an account by name or email"
          className={`${controlClass(false, { inline: true })} min-w-0 flex-1`}
        />
        <Button type="submit" variant="secondary" icon={Search} loading={users.isPending}>
          Find
        </Button>
      </form>
      {users.data?.length === 0 && (
        <p className="text-sm text-text-muted">
          No accounts match. The person needs a HealthBridge account first.
        </p>
      )}
      <ul className="divide-y divide-border">
        {users.data?.map((u) => (
          <li key={u.id} className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm">
            <span>
              {u.fullName} <span className="text-text-subtle">· {u.email}</span>
            </span>
            <Button
              size="sm"
              variant="secondary"
              icon={UserCog}
              onClick={() => choose(u)}
              disabled={appoint.isPending || u.status === 'disabled'}
            >
              {u.status === 'disabled' ? 'Account disabled' : 'Appoint'}
            </Button>
          </li>
        ))}
      </ul>
      {message && <Alert tone={message.tone}>{message.text}</Alert>}
    </div>
  );
}

function ClinicCard({ clinic, onChanged }) {
  const queryClient = useQueryClient();
  const [panel, setPanel] = useState(null);
  const { confirm, dialog } = useConfirm();
  const status = useSafeMutation({
    mutationFn: (next) => adminApi.setClinicStatus(clinic.id, next),
    onSuccess: onChanged,
  });
  const active = clinic.status === 'active';
  const toggle = async () => {
    const ok = await confirm(
      active
        ? {
            title: `Deactivate ${clinic.name}?`,
            description:
              'While inactive, no administrator can be appointed and no doctor invited, and the clinic is no longer shown on doctors’ profiles. Existing appointments are not cancelled. You can reactivate it at any time.',
            confirmLabel: 'Deactivate clinic',
            destructive: true,
            tone: 'warning',
          }
        : {
            title: `Reactivate ${clinic.name}?`,
            description:
              'Its doctors appear with the clinic again, and administrators can be appointed and doctors invited.',
            confirmLabel: 'Reactivate clinic',
          },
    );
    if (ok) status.mutate(active ? 'inactive' : 'active');
  };
  const address = [clinic.addressLine, clinic.city, clinic.state, clinic.postalCode]
    .filter(Boolean)
    .join(', ');
  return (
    <Card>
      {dialog}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 font-medium text-text">
            {clinic.name} <StatusBadge status={clinic.status} />
          </p>
          <p className="text-sm text-text-muted">
            {address || 'No address yet'}
            {clinic.phone && ` · ${clinic.phone}`} · created {formatFullDate(clinic.createdAt)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant={panel === 'members' ? 'primary' : 'secondary'}
            icon={UsersRound}
            aria-expanded={panel === 'members'}
            onClick={() => setPanel(panel === 'members' ? null : 'members')}
          >
            Members
          </Button>
          <Button
            size="sm"
            variant={panel === 'appoint' ? 'primary' : 'secondary'}
            icon={UserCog}
            aria-expanded={panel === 'appoint'}
            disabled={!active}
            onClick={() => setPanel(panel === 'appoint' ? null : 'appoint')}
          >
            Appoint administrator
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={Power}
            onClick={toggle}
            loading={status.isPending}
          >
            {active ? 'Deactivate' : 'Reactivate'}
          </Button>
        </div>
      </div>
      {status.isError && (
        <Alert tone="error" className="mt-3">
          {authErrorMessage(status.error)}
        </Alert>
      )}
      {panel && (
        <div className="mt-4">
          {panel === 'members' ? (
            <Members clinicId={clinic.id} />
          ) : (
            <AppointAdmin
              clinic={clinic}
              onAppointed={() =>
                queryClient.invalidateQueries({ queryKey: ['clinic', clinic.id, 'members'] })
              }
            />
          )}
        </div>
      )}
    </Card>
  );
}

/** Platform admin: clinic management. */
export function ClinicsAdminPage() {
  const queryClient = useQueryClient();
  const [show, setShow] = useState('all');
  const clinics = useQuery({ queryKey: ['admin', 'clinics'], queryFn: adminApi.clinics });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin', 'clinics'] });
  const all = clinics.data ?? [];
  const shown = all.filter((c) => show === 'all' || c.status === show);
  return (
    <div className="space-y-6">
      <PageHeader
        icon={Building2}
        eyebrow="Administration"
        title="Clinics"
        description="Create clinics, activate or deactivate them, see who belongs to each, and appoint their administrators. Clinic administrators manage their own clinic only."
      />
      <PlatformBoundary compact />
      <CreateClinic onCreated={refresh} />
      <div className="flex flex-wrap gap-2" role="group" aria-label="Show">
        {[
          ['all', 'All'],
          ['active', 'Active'],
          ['inactive', 'Inactive'],
        ].map(([key, label]) => (
          <Button
            key={key}
            size="sm"
            variant={show === key ? 'primary' : 'secondary'}
            aria-pressed={show === key}
            onClick={() => setShow(key)}
          >
            {label} ({all.filter((c) => key === 'all' || c.status === key).length})
          </Button>
        ))}
      </div>
      {clinics.isPending && <LoadingState label="Loading clinics" rows={2} />}
      {clinics.isError && <Alert tone="error">{authErrorMessage(clinics.error)}</Alert>}
      {clinics.isSuccess && shown.length === 0 && (
        <EmptyState icon={Building2} title="No clinics here">
          {all.length ? 'No clinics have this status.' : 'Create the first clinic above.'}
        </EmptyState>
      )}
      <ul className="space-y-3">
        {shown.map((clinic) => (
          <li key={clinic.id}>
            <ClinicCard clinic={clinic} onChanged={refresh} />
          </li>
        ))}
      </ul>
    </div>
  );
}
