import { useState } from 'react';
import { Link } from 'react-router';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { DOCUMENT_TYPES } from '@healthbridge/shared';
import { careApi, consentsApi } from '../../lib/domainApi.js';
import { authErrorMessage } from '../auth/errorMessages.js';
import { Card } from '../../components/ui/Card.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { Button, ButtonLink } from '../../components/ui/Button.jsx';
import { Badge, StatusBadge } from '../../components/ui/Badge.jsx';
import { Skeleton } from '../../components/ui/Skeleton.jsx';
import { EmptyState, LoadingState } from '../../components/ui/EmptyState.jsx';
import { SelectField } from '../../components/ui/SelectField.jsx';
import { CheckboxField, RadioGroup } from '../../components/ui/Fields.jsx';
import { PageHeader, SectionHeader } from '../../components/ui/Typography.jsx';
import { PersonIdentity } from '../../components/ui/Identity.jsx';
import { useConfirm } from '../../components/ui/useConfirm.jsx';
import { formatDateTime, formatDay, formatTime } from '../appointments/format.js';
import { usePatientChoice } from './usePatientChoice.js';
import { PatientSelect } from './PatientSelect.jsx';
import { PURPOSE_LABELS } from './labels.js';
import { DOCUMENT_TYPE_LABELS } from './upload.js';
import { MissingProfileNotice } from '../patients/MissingProfileNotice.jsx';
import {
  Ban,
  ChevronDown,
  Eye,
  HelpCircle,
  KeyRound,
  Lock,
  ShieldCheck,
  ShieldOff,
  Sparkles,
  Stethoscope,
  UserRound,
} from 'lucide-react';
import { useSafeMutation } from '../../lib/useSafeMutation.js';

/** What each kind of access lets a doctor do, in plain words. */
const SCOPE_HELP = {
  patient_profile: ['Your profile', 'Name, date of birth, contact and emergency contact.'],
  medical_documents: [
    'Your documents',
    'View and download the reports and documents in Health Records.',
  ],
  medical_documents_upload: [
    'Add documents',
    'Let the doctor add reports to your record, for example results of tests they ordered.',
  ],
};
const DURATIONS = [
  ['7', '1 week'],
  ['30', '30 days'],
  ['90', '90 days'],
  ['365', '1 year'],
];

const listText = (items) =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

/** "Can see your profile and documents (lab reports only) · for ongoing care". */
function accessSentence(c) {
  const what = listText(c.scopes.map((s) => SCOPE_HELP[s][0].toLowerCase()));
  const types = c.documentTypes
    ? ` (${c.documentTypes.map((t) => DOCUMENT_TYPE_LABELS[t].toLowerCase()).join(', ')} only)`
    : '';
  return `Can see ${what}${types}, for ${PURPOSE_LABELS[c.purpose].toLowerCase()}.`;
}

const daysLeft = (iso, now) => Math.max(0, Math.ceil((new Date(iso) - now) / 86_400_000));

function HowSharingWorks() {
  return (
    <details className="group rounded-xl border border-border bg-surface-raised px-4 py-3">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium text-primary">
        <HelpCircle aria-hidden="true" className="h-4 w-4" />
        How sharing works
        <ChevronDown
          aria-hidden="true"
          className="ml-auto h-4 w-4 transition-transform group-open:rotate-180"
        />
      </summary>
      <dl className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
        {[
          [
            'Who',
            'Only doctors in your care team, one doctor at a time. HealthBridge staff and administrators never get access to your records.',
          ],
          [
            'What',
            'You choose: your profile, your documents, or both. You can limit documents to certain kinds, such as lab reports.',
          ],
          [
            'Why',
            'You give a reason, such as ongoing care or a second opinion. It is recorded with the access.',
          ],
          [
            'How long',
            'Access ends automatically on the date you choose. Access shared for one appointment ends 72 hours after it.',
          ],
          [
            'Revoking',
            'Revoke at any time below. It takes effect immediately: the doctor’s next request is refused.',
          ],
          [
            'Checking',
            'Every time someone opens your records, or is refused, it is listed under “Who looked at my records”.',
          ],
        ].map(([term, text]) => (
          <div key={term}>
            <dt className="font-medium text-text">{term}</dt>
            <dd className="text-text-muted">{text}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function GrantForm({ patientId, onGranted }) {
  const team = useQuery({
    queryKey: ['care', patientId],
    queryFn: () => careApi.list(patientId),
    enabled: Boolean(patientId),
  });
  const doctors = (team.data ?? []).filter((r) => r.status === 'active');
  const [doctorId, setDoctorId] = useState('');
  const [scopes, setScopes] = useState(['patient_profile', 'medical_documents']);
  const [types, setTypes] = useState([]);
  const [purpose, setPurpose] = useState('ongoing_care');
  const [days, setDays] = useState('30');
  const [now] = useState(() => Date.now());
  const toggle = (list, setList, value) =>
    setList(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  const chosen = doctors.find((r) => r.doctorId === (doctorId || doctors[0]?.doctorId));

  const grant = useSafeMutation({
    mutationFn: () =>
      consentsApi.grant({
        patientId,
        doctorId: chosen.doctorId,
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
      <EmptyState
        compact
        icon={Stethoscope}
        title="Add a doctor to your care team first"
        action={
          <ButtonLink as={Link} to="/app/doctors" size="sm" variant="secondary">
            Go to My Doctors
          </ButtonLink>
        }
      >
        You can share records only with doctors who have accepted you into their care.
      </EmptyState>
    );
  }
  const until = formatDay(new Date(now + Number(days) * 86_400_000).toISOString());
  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        grant.mutate();
      }}
    >
      <SelectField
        label="1. Who"
        hint="Doctors in your care team."
        value={chosen?.doctorId ?? ''}
        onChange={(e) => setDoctorId(e.target.value)}
        options={doctors.map((r) => ({ value: r.doctorId, label: r.doctor.professionalName }))}
      />
      <fieldset>
        <legend className="text-sm font-medium text-text">2. What they can see</legend>
        <div className="mt-2 space-y-3">
          {Object.entries(SCOPE_HELP).map(([value, [label, description]]) => (
            <CheckboxField
              key={value}
              label={label}
              description={description}
              checked={scopes.includes(value)}
              onChange={() => toggle(scopes, setScopes, value)}
            />
          ))}
        </div>
        {scopes.includes('medical_documents') && (
          <details className="mt-3 pl-8">
            <summary className="cursor-pointer text-sm text-primary">
              Only some kinds of documents{types.length ? ` (${types.length} chosen)` : ''}
            </summary>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {DOCUMENT_TYPES.map((t) => (
                <CheckboxField
                  key={t}
                  label={DOCUMENT_TYPE_LABELS[t]}
                  checked={types.includes(t)}
                  onChange={() => toggle(types, setTypes, t)}
                />
              ))}
            </div>
            <p className="mt-2 text-xs text-text-subtle">Leave all unticked to share every kind.</p>
          </details>
        )}
      </fieldset>
      <SelectField
        label="3. Why"
        value={purpose}
        onChange={(e) => setPurpose(e.target.value)}
        options={Object.entries(PURPOSE_LABELS).map(([value, label]) => ({ value, label }))}
      />
      <RadioGroup
        legend="4. For how long"
        inline
        name="duration"
        value={days}
        onChange={setDays}
        options={DURATIONS.map(([value, label]) => ({ value, label }))}
      />
      {chosen && scopes.length > 0 && (
        <p className="rounded-lg bg-primary-soft px-4 py-3 text-sm text-text">
          <span className="font-medium">{chosen.doctor.professionalName}</span> will be able to see{' '}
          {listText(scopes.map((s) => SCOPE_HELP[s][0].toLowerCase()))} until {until}. You can
          revoke this at any time.
        </p>
      )}
      {!scopes.length && <p className="text-sm text-danger">Choose at least one thing to share.</p>}
      {grant.isError && <Alert tone="error">{authErrorMessage(grant.error)}</Alert>}
      <Button type="submit" icon={KeyRound} disabled={!scopes.length} loading={grant.isPending}>
        Give access
      </Button>
    </form>
  );
}

const ACTOR_ICONS = {
  doctor: Stethoscope,
  you: UserRound,
  patient: UserRound,
  guardian: UserRound,
};
const FILTERS = [
  ['all', 'Everything'],
  ['doctors', 'Doctors'],
  ['refused', 'Refused'],
];

function AccessLog({ patientId }) {
  const [filter, setFilter] = useState('all');
  const log = useInfiniteQuery({
    queryKey: ['access-log', patientId],
    queryFn: ({ pageParam }) => consentsApi.accessLog(patientId, pageParam),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.meta?.nextCursor ?? undefined,
    enabled: Boolean(patientId),
  });
  const all = log.data?.pages.flatMap((p) => p.data) ?? [];
  const items = all.filter((e) =>
    filter === 'doctors'
      ? e.actor?.kind === 'doctor'
      : filter === 'refused'
        ? e.outcome === 'denied'
        : true,
  );
  const days = [];
  for (const e of items) {
    const day = formatDay(e.occurredAt);
    if (days.at(-1)?.[0] !== day) days.push([day, []]);
    days.at(-1)[1].push(e);
  }
  return (
    <Card>
      <SectionHeader
        icon={Eye}
        title="Who looked at my records"
        description="Every time someone opened your records or a document, and every refused attempt. Newest first."
      />
      <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Show">
        {FILTERS.map(([key, label]) => (
          <Button
            key={key}
            size="sm"
            variant={filter === key ? 'primary' : 'secondary'}
            aria-pressed={filter === key}
            onClick={() => setFilter(key)}
          >
            {label}
          </Button>
        ))}
      </div>
      {log.isPending && <LoadingState label="Loading access history" rows={2} className="mt-4" />}
      {log.isError && (
        <Alert tone="error" className="mt-4">
          {authErrorMessage(log.error)}
        </Alert>
      )}
      {log.isSuccess && items.length === 0 && (
        <div className="mt-4">
          <EmptyState
            compact
            icon={Eye}
            title={
              filter === 'refused'
                ? 'No refused attempts'
                : filter === 'doctors'
                  ? 'No doctor has opened your records'
                  : 'Nobody has accessed these records yet'
            }
          >
            When a doctor opens something you shared, it is listed here with the date and time.
          </EmptyState>
        </div>
      )}
      <div className="mt-2">
        {days.map(([day, entries]) => (
          <section key={day} className="mt-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-text-subtle">
              {day}
            </h3>
            <ul className="mt-1 divide-y divide-border">
              {entries.map((e, i) => {
                const denied = e.outcome === 'denied';
                const Icon = denied
                  ? Ban
                  : (ACTOR_ICONS[e.actor?.kind] ??
                    (e.actor?.kind === 'system' ? ShieldCheck : Sparkles));
                return (
                  <li
                    key={`${e.occurredAt}-${i}`}
                    className="flex items-start gap-3 py-2.5 text-sm"
                  >
                    <Icon
                      aria-hidden="true"
                      className={`mt-0.5 h-4 w-4 shrink-0 ${
                        denied
                          ? 'text-danger'
                          : e.actor?.kind === 'doctor'
                            ? 'text-primary'
                            : 'text-text-subtle'
                      }`}
                    />
                    <span className={`min-w-0 flex-1 ${denied ? 'text-danger' : 'text-text'}`}>
                      {e.description}
                      {denied && <span className="sr-only"> (refused)</span>}
                    </span>
                    <time className="shrink-0 text-text-subtle" dateTime={e.occurredAt}>
                      {formatTime(e.occurredAt)}
                    </time>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
      {log.hasNextPage && (
        <Button
          variant="ghost"
          className="mt-2"
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
  const [now] = useState(() => Date.now());
  const consents = useQuery({
    queryKey: ['consents', patientId],
    queryFn: () => consentsApi.list(patientId),
    enabled: Boolean(patientId),
  });
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['consents', patientId] });
    queryClient.invalidateQueries({ queryKey: ['access-log', patientId] });
  };
  const revoke = useSafeMutation({
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
        eyebrow="Account"
        title="Privacy & Access"
        description="Your records are private. Doctors see them only when you share them: you choose who, what and for how long, and you can revoke access at any time."
        actions={<PatientSelect choices={choices} value={patientId} onChange={setPatientId} />}
      />
      <HowSharingWorks />

      <Card>
        {dialog}
        <SectionHeader
          icon={ShieldCheck}
          title="Who can see my records now"
          description={
            active.length
              ? `${active.length} doctor${active.length === 1 ? '' : 's'} currently ${active.length === 1 ? 'has' : 'have'} access.`
              : undefined
          }
        />
        {consents.isPending && <LoadingState label="Loading access" rows={1} className="mt-4" />}
        {consents.isError && <Alert tone="error">{authErrorMessage(consents.error)}</Alert>}
        {revoke.isError && <Alert tone="error">{authErrorMessage(revoke.error)}</Alert>}
        {consents.isSuccess && active.length === 0 && (
          <div className="mt-3">
            <EmptyState compact icon={Lock} title="No doctor can see your records">
              Your records are private. To share them, use “Share with a doctor” below, or share for
              one appointment from the appointment’s page.
            </EmptyState>
          </div>
        )}
        <ul className="divide-y divide-border">
          {active.map((c) => (
            <li key={c.id} className="flex flex-wrap items-start justify-between gap-3 py-4">
              <div className="min-w-0 space-y-2">
                <PersonIdentity name={c.doctor.professionalName} verified />
                <p className="text-sm text-text">{accessSentence(c)}</p>
                <p className="flex flex-wrap items-center gap-2 text-sm text-text-muted">
                  <Badge tone="success" icon={ShieldCheck}>
                    Active
                  </Badge>
                  Until {formatDateTime(c.expiresAt)} ({daysLeft(c.expiresAt, now)} day
                  {daysLeft(c.expiresAt, now) === 1 ? '' : 's'} left)
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
          <details className="mt-4 border-t border-border pt-3">
            <summary className="cursor-pointer text-sm text-text-muted">
              Ended access ({past.length})
            </summary>
            <ul className="mt-2 divide-y divide-border">
              {past.map((c) => (
                <li
                  key={c.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm text-text-muted"
                >
                  <span>
                    {c.doctor.professionalName}
                    <span className="block text-xs">
                      {c.status === 'revoked'
                        ? `Revoked ${c.revokedAt ? formatDateTime(c.revokedAt) : ''}`
                        : `Ended ${formatDateTime(c.expiresAt)}`}
                    </span>
                  </span>
                  <StatusBadge status={c.status} />
                </li>
              ))}
            </ul>
          </details>
        )}
      </Card>

      <Card>
        <SectionHeader
          icon={KeyRound}
          title="Share with a doctor"
          description="Four quick choices. Nothing is shared until you press “Give access”."
          className="mb-5"
        />
        <GrantForm patientId={patientId} onGranted={refresh} />
      </Card>

      <AccessLog patientId={patientId} />
    </div>
  );
}
