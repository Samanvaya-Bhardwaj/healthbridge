import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DOCUMENT_TYPES } from '@healthbridge/shared';
import { careApi, consentsApi } from '../../lib/domainApi.js';
import { authErrorMessage } from '../auth/errorMessages.js';
import { Card } from '../../components/ui/Card.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { StatusBadge } from '../../components/ui/Badge.jsx';
import { Skeleton } from '../../components/ui/Skeleton.jsx';
import { EmptyState } from '../../components/ui/EmptyState.jsx';
import { SelectField } from '../../components/ui/SelectField.jsx';
import { formatDateTime } from '../appointments/format.js';
import { usePatientChoice } from './usePatientChoice.js';
import { PatientSelect } from './PatientSelect.jsx';
import { PURPOSE_LABELS, SCOPE_LABELS } from './labels.js';
import { DOCUMENT_TYPE_LABELS } from './upload.js';
import { ShieldCheck } from 'lucide-react';
import { PageHeader } from '../../components/ui/Typography.jsx';
import { MissingProfileNotice } from '../patients/MissingProfileNotice.jsx';
import { SectionHeader } from '../../components/ui/Typography.jsx';
import { LoadingState } from '../../components/ui/EmptyState.jsx';
import { PersonIdentity } from '../../components/ui/Identity.jsx';
import { useConfirm } from '../../components/ui/useConfirm.jsx';
import { Eye, KeyRound, Lock, ShieldOff } from 'lucide-react';

function GrantForm({ patientId, onGranted }) {
  const team = useQuery({
    queryKey: ['care', patientId],
    queryFn: () => careApi.list(patientId),
    enabled: Boolean(patientId),
  });
  const doctors = (team.data ?? []).filter((r) => r.status === 'active');
  const [doctorId, setDoctorId] = useState('');
  const [scopes, setScopes] = useState(['medical_documents']);
  const [types, setTypes] = useState([]);
  const [purpose, setPurpose] = useState('ongoing_care');
  const [days, setDays] = useState('30');
  const toggle = (list, setList, value) =>
    setList(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

  const grant = useMutation({
    mutationFn: () =>
      consentsApi.grant({
        patientId,
        doctorId: doctorId || doctors[0]?.doctorId,
        kind: 'manual',
        scopes,
        ...(types.length ? { documentTypes: types } : {}),
        purpose,
        expiresInDays: Number(days),
      }),
    onSuccess: onGranted,
  });

  if (team.isPending) return <Skeleton className="h-24 w-full" />;
  if (!doctors.length) {
    return (
      <p className="text-sm text-text-muted">
        Add a doctor to your care team first; you can then choose what they may see.
      </p>
    );
  }
  return (
    <form
      className="grid gap-4 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        grant.mutate();
      }}
    >
      <SelectField
        label="Doctor"
        value={doctorId || doctors[0].doctorId}
        onChange={(e) => setDoctorId(e.target.value)}
        options={doctors.map((r) => ({ value: r.doctorId, label: r.doctor.professionalName }))}
      />
      <SelectField
        label="Purpose"
        value={purpose}
        onChange={(e) => setPurpose(e.target.value)}
        options={Object.entries(PURPOSE_LABELS).map(([value, label]) => ({ value, label }))}
      />
      <fieldset>
        <legend className="text-sm font-medium text-text">Access</legend>
        {Object.entries(SCOPE_LABELS).map(([value, label]) => (
          <label key={value} className="mt-2 flex items-center gap-2 text-sm text-text">
            <input
              type="checkbox"
              checked={scopes.includes(value)}
              onChange={() => toggle(scopes, setScopes, value)}
            />
            {label}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend className="text-sm font-medium text-text">Document types (none = all)</legend>
        {DOCUMENT_TYPES.map((t) => (
          <label key={t} className="mt-2 flex items-center gap-2 text-sm text-text">
            <input
              type="checkbox"
              checked={types.includes(t)}
              onChange={() => toggle(types, setTypes, t)}
            />
            {DOCUMENT_TYPE_LABELS[t]}
          </label>
        ))}
      </fieldset>
      <SelectField
        label="For how long"
        value={days}
        onChange={(e) => setDays(e.target.value)}
        options={[
          { value: '7', label: '1 week' },
          { value: '30', label: '30 days' },
          { value: '90', label: '90 days' },
          { value: '365', label: '1 year' },
        ]}
      />
      {grant.isError && (
        <Alert tone="error" className="sm:col-span-2">
          {authErrorMessage(grant.error)}
        </Alert>
      )}
      <div className="sm:col-span-2">
        <Button type="submit" disabled={!scopes.length || grant.isPending}>
          Give access
        </Button>
      </div>
    </form>
  );
}

function AccessLog({ patientId }) {
  const log = useInfiniteQuery({
    queryKey: ['access-log', patientId],
    queryFn: ({ pageParam }) => consentsApi.accessLog(patientId, pageParam),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.meta?.nextCursor ?? undefined,
    enabled: Boolean(patientId),
  });
  const items = log.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <Card>
      <SectionHeader
        icon={Eye}
        title="Who looked at my records"
        description="Every time a doctor opened your records or a document, and every refused attempt."
      />
      {log.isPending && <LoadingState label="Loading access history" rows={2} className="mt-4" />}
      {log.isError && <Alert tone="error">{authErrorMessage(log.error)}</Alert>}
      {log.isSuccess && items.length === 0 && (
        <div className="mt-3">
          <EmptyState compact icon={Eye} title="Nobody has accessed these records yet">
            When a doctor opens something you shared, it is listed here.
          </EmptyState>
        </div>
      )}
      <ul className="mt-2 divide-y divide-border">
        {items.map((e, i) => (
          <li
            key={`${e.occurredAt}-${i}`}
            className="flex flex-wrap justify-between gap-2 py-2.5 text-sm"
          >
            <span className={e.outcome === 'denied' ? 'text-danger' : 'text-text'}>
              {e.description}
            </span>
            <time className="text-text-subtle" dateTime={e.occurredAt}>
              {formatDateTime(e.occurredAt)}
            </time>
          </li>
        ))}
      </ul>
      {log.hasNextPage && (
        <Button
          variant="ghost"
          onClick={() => log.fetchNextPage()}
          disabled={log.isFetchingNextPage}
        >
          Show older
        </Button>
      )}
    </Card>
  );
}

/** Privacy & Access: who may see the records (consents) and who did (access log). */
export function PrivacyPage() {
  const queryClient = useQueryClient();
  const { choices, patientId, setPatientId, isPending, missingProfile } = usePatientChoice();
  const consents = useQuery({
    queryKey: ['consents', patientId],
    queryFn: () => consentsApi.list(patientId),
    enabled: Boolean(patientId),
  });
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['consents', patientId] });
    queryClient.invalidateQueries({ queryKey: ['access-log', patientId] });
  };
  const revoke = useMutation({
    mutationFn: (id) => consentsApi.revoke(id, 'no_longer_needed'),
    onSuccess: refresh,
  });
  const { confirm, dialog } = useConfirm();
  const confirmRevoke = async (c) => {
    const ok = await confirm({
      title: `Revoke ${c.doctor.professionalName}’s access?`,
      description:
        'From their next request they can no longer see what you shared, including during a consultation. You can give access again at any time.',
      confirmLabel: 'Revoke access',
      destructive: true,
    });
    if (ok) revoke.mutate(c.id);
  };

  if (isPending) return <Skeleton className="h-40 w-full" />;
  if (missingProfile) return <MissingProfileNotice />;
  const active = (consents.data ?? []).filter((c) => c.status === 'active');
  const past = (consents.data ?? []).filter((c) => c.status !== 'active');

  return (
    <div className="space-y-6">
      <PageHeader
        icon={ShieldCheck}
        eyebrow="My health"
        title="Privacy & Access"
        description="Doctors see your records only with your permission. Choose who sees what and for how long; withdraw it at any time and it takes effect immediately. Below, you can see every time someone opened your records."
        actions={<PatientSelect choices={choices} value={patientId} onChange={setPatientId} />}
      />

      <Card>
        {dialog}
        <SectionHeader icon={ShieldCheck} title="Who has access" />
        {consents.isPending && <LoadingState label="Loading access" rows={1} className="mt-4" />}
        {consents.isError && <Alert tone="error">{authErrorMessage(consents.error)}</Alert>}
        {revoke.isError && <Alert tone="error">{authErrorMessage(revoke.error)}</Alert>}
        {consents.isSuccess && active.length === 0 && (
          <div className="mt-3">
            <EmptyState compact icon={Lock} title="No doctor can see your records">
              Your records are private. To share them for a consultation, give a doctor in your care
              team access below; you choose what they see and for how long.
            </EmptyState>
          </div>
        )}
        <ul className="divide-y divide-border">
          {active.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <PersonIdentity name={c.doctor.professionalName} verified />
                <p className="mt-2 text-sm text-text-muted">
                  {c.scopes.map((s) => SCOPE_LABELS[s]).join(', ')}
                  {c.documentTypes &&
                    ` (${c.documentTypes.map((t) => DOCUMENT_TYPE_LABELS[t]).join(', ')})`}{' '}
                  · {PURPOSE_LABELS[c.purpose]} · until {formatDateTime(c.expiresAt)}
                  {c.kind === 'appointment' && ' · for one appointment'}
                </p>
              </div>
              <Button
                variant="secondary"
                icon={ShieldOff}
                onClick={() => confirmRevoke(c)}
                disabled={revoke.isPending}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
        {past.length > 0 && (
          <details className="mt-4">
            <summary className="cursor-pointer text-sm text-text-muted">
              Past access ({past.length})
            </summary>
            <ul className="mt-2 divide-y divide-border">
              {past.map((c) => (
                <li
                  key={c.id}
                  className="flex items-center justify-between py-2 text-sm text-text-muted"
                >
                  {c.doctor.professionalName}{' '}
                  <StatusBadge status={c.status === 'revoked' ? 'ended' : c.status} />
                </li>
              ))}
            </ul>
          </details>
        )}
      </Card>

      <Card>
        <SectionHeader
          icon={KeyRound}
          title="Give a doctor access"
          description="Only doctors in your care team are listed. Access ends automatically on the date you choose."
          className="mb-4"
        />
        <GrantForm patientId={patientId} onGranted={refresh} />
      </Card>

      <AccessLog patientId={patientId} />
    </div>
  );
}
