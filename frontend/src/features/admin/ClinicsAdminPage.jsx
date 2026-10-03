import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { adminApi } from '../../lib/domainApi.js';
import { authErrorMessage } from '../auth/errorMessages.js';
import { Card } from '../../components/ui/Card.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { StatusBadge } from '../../components/ui/Badge.jsx';
import { Skeleton } from '../../components/ui/Skeleton.jsx';
import { Building2 } from 'lucide-react';
import { PageHeader } from '../../components/ui/Typography.jsx';
import { controlClass } from '../../components/ui/fieldStyles.js';

function AppointAdmin({ clinic }) {
  const [q, setQ] = useState('');
  const [message, setMessage] = useState(null);
  const users = useMutation({ mutationFn: () => adminApi.findUsers(q) });
  const appoint = useMutation({
    mutationFn: (user) => adminApi.appointClinicAdmin(clinic.id, user.id),
    onSuccess: () => setMessage({ tone: 'success', text: 'Clinic administrator appointed.' }),
    onError: (error) => setMessage({ tone: 'error', text: authErrorMessage(error) }),
  });
  return (
    <div className="mt-4 space-y-3">
      <form
        className="flex flex-wrap gap-2"
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
          placeholder="Find user by name or email"
          className={`${controlClass(false, { inline: true })} flex-1`}
        />
        <Button type="submit" variant="secondary">
          Find
        </Button>
      </form>
      <ul className="divide-y divide-border">
        {users.data?.map((u) => (
          <li key={u.id} className="flex items-center justify-between gap-3 py-2 text-sm">
            <span>
              {u.fullName} <span className="text-text-subtle">· {u.email}</span>
            </span>
            <Button variant="ghost" onClick={() => appoint.mutate(u)}>
              Appoint as clinic admin
            </Button>
          </li>
        ))}
      </ul>
      {message && <Alert tone={message.tone}>{message.text}</Alert>}
    </div>
  );
}

/** Platform admin: clinic management basics. */
export function ClinicsAdminPage() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ name: '', city: '' });
  const [open, setOpen] = useState(null);
  const clinics = useQuery({ queryKey: ['admin', 'clinics'], queryFn: adminApi.clinics });
  const create = useMutation({
    mutationFn: () => adminApi.createClinic(form),
    onSuccess: () => {
      setForm({ name: '', city: '' });
      queryClient.invalidateQueries({ queryKey: ['admin', 'clinics'] });
    },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Building2}
        eyebrow="Administration"
        title="Clinics"
        description="Create clinics, activate them, and appoint their administrators. Clinic administrators manage their own clinic only."
      />
      <Card>
        <h2 className="text-base font-semibold text-text">New clinic</h2>
        <form
          className="mt-4 flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          {['name', 'city'].map((key) => (
            <div key={key} className="flex-1">
              <label className="sr-only" htmlFor={`clinic-${key}`}>
                {key}
              </label>
              <input
                id={`clinic-${key}`}
                required={key === 'name'}
                value={form[key]}
                onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                placeholder={key === 'name' ? 'Clinic name' : 'City'}
                className={controlClass(false, { inline: true })}
              />
            </div>
          ))}
          <Button type="submit" disabled={create.isPending}>
            Create clinic
          </Button>
        </form>
        {create.isError && (
          <Alert tone="error" className="mt-4">
            {authErrorMessage(create.error)}
          </Alert>
        )}
      </Card>
      {clinics.isPending && <Skeleton className="h-24 w-full" />}
      {clinics.data?.map((clinic) => (
        <Card key={clinic.id}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="flex items-center gap-2 font-medium text-text">
              {clinic.name} <StatusBadge status={clinic.status} />
              {clinic.city && (
                <span className="text-sm font-normal text-text-subtle">{clinic.city}</span>
              )}
            </p>
            <Button
              variant="secondary"
              onClick={() => setOpen(open === clinic.id ? null : clinic.id)}
            >
              {open === clinic.id ? 'Close' : 'Appoint administrator'}
            </Button>
          </div>
          {open === clinic.id && <AppointAdmin clinic={clinic} />}
        </Card>
      ))}
    </div>
  );
}
