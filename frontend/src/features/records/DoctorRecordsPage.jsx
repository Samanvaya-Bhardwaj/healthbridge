import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  consentsApi,
  doctorsApi,
  followUpApi,
  recordsApi,
  schedulingApi,
} from '../../lib/domainApi.js';
import { authErrorMessage } from '../auth/errorMessages.js';
import { Card } from '../../components/ui/Card.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { Skeleton } from '../../components/ui/Skeleton.jsx';
import {
  ConsentRequiredNotice,
  EmptyState,
  LoadingState,
} from '../../components/ui/EmptyState.jsx';
import { StatusBadge } from '../../components/ui/Badge.jsx';
import { Tabs } from '../../components/ui/Tabs.jsx';
import { SectionHeader } from '../../components/ui/Typography.jsx';
import {
  CalendarDays,
  ClipboardList,
  FlaskConical,
  HeartPulse,
  History,
  Pill,
  Sparkles,
} from 'lucide-react';
import { ACTIVE, ageFrom, useSharedRecords } from '../doctors/doctorWork.js';
import { MODE_LABELS, formatDateOnly, formatDateTime } from '../appointments/format.js';
import { DocumentList } from './DocumentList.jsx';
import { ExtractionPanel, LabResults } from './ExtractionPanel.jsx';
import { PatientPrescriptions } from '../consultations/Prescriptions.jsx';
import { Timeline } from './Timeline.jsx';
import { AskRecords } from './AiAssist.jsx';
import { useDownload } from './useDownload.js';
import { SCOPE_LABELS } from './labels.js';
import { FileText } from 'lucide-react';
import { PageHeader } from '../../components/ui/Typography.jsx';
import { BackLink } from '../../components/ui/BackLink.jsx';
import { FolderOpen } from 'lucide-react';
import { PersonIdentity } from '../../components/ui/Identity.jsx';
import { ButtonLink } from '../../components/ui/Button.jsx';
import { ShieldCheck } from 'lucide-react';

/**
 * Doctor: patients who shared records. The list is just the doctor's own active consents;
 * every records request is still authorised by the server (consent checked per request).
 */
/** Extracted values for one document, loaded (and audited) only when the doctor opens them. */
function ReviewValues({ documentId }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="mt-2" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cursor-pointer text-sm text-primary">Review extracted values</summary>
      {open && (
        <div className="mt-2">
          <ExtractionPanel documentId={documentId} canVerify />
        </div>
      )}
    </details>
  );
}

export function DoctorRecordsPage() {
  const received = useQuery({ queryKey: ['consents', 'received'], queryFn: consentsApi.received });
  const active = (received.data ?? []).filter(
    (c) => c.status === 'active' && c.scopes.includes('medical_documents'),
  );
  return (
    <div className="space-y-6">
      <PageHeader
        icon={FileText}
        eyebrow="Patients"
        title="Patient Records"
        description="Records your patients have chosen to share with you. Access ends the moment a patient revokes it, or when it expires."
      />
      {received.isPending && <Skeleton className="h-24 w-full" />}
      {received.isError && <Alert tone="error">{authErrorMessage(received.error)}</Alert>}
      {received.isSuccess && active.length === 0 && (
        <EmptyState icon={ShieldCheck} title="No records shared with you yet">
          Patients share records from their Privacy &amp; Access page, choosing what you can see and
          for how long. Shared records appear here until the access ends.
        </EmptyState>
      )}
      <ul className="space-y-3">
        {active.map((c) => (
          <li key={c.id}>
            <Card className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <PersonIdentity name={c.patientName} tone="neutral" />
                <p className="mt-2 flex items-center gap-1.5 text-sm text-text-muted">
                  <ShieldCheck aria-hidden="true" className="h-4 w-4 text-primary" />
                  {c.scopes.map((s) => SCOPE_LABELS[s]).join(', ')} · until{' '}
                  {formatDateTime(c.expiresAt)}
                </p>
              </div>
              <ButtonLink
                as={Link}
                to={`/app/medical-records/${c.patientId}`}
                variant="secondary"
                icon={FolderOpen}
              >
                Open records
              </ButtonLink>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}

const RECORD_TABS = [
  ['overview', 'Overview', ClipboardList],
  ['documents', 'Documents', FileText],
  ['timeline', 'Timeline', History],
  ['ask', 'Ask AI', Sparkles],
];

function UpcomingWithPatient({ patientId }) {
  const [range] = useState(() => {
    const from = new Date();
    return {
      from: from.toISOString(),
      to: new Date(from.getTime() + 62 * 86_400_000).toISOString(),
    };
  });
  const upcoming = useQuery({
    queryKey: ['doctor-schedule', 'upcoming62'],
    queryFn: () => schedulingApi.doctorSchedule(range.from, range.to),
  });
  const mine = (upcoming.data ?? []).filter(
    (a) => a.patientId === patientId && ACTIVE.includes(a.status),
  );
  if (!mine.length) return null;
  return (
    <Card>
      <SectionHeader icon={CalendarDays} title="Upcoming consultations" />
      <ul className="mt-2 divide-y divide-border">
        {mine.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
            <span className="text-sm text-text">
              <span className="font-medium">{formatDateTime(a.startsAt)}</span> ·{' '}
              {MODE_LABELS[a.mode]}
            </span>
            <span className="flex flex-wrap gap-2">
              <ButtonLink
                as={Link}
                to={`/app/appointments/${a.id}/brief`}
                size="sm"
                variant="ai"
                icon={Sparkles}
              >
                AI brief
              </ButtonLink>
              <ButtonLink
                as={Link}
                to={`/app/appointments/${a.id}/consultation`}
                size="sm"
                variant="secondary"
              >
                Open appointment
              </ButtonLink>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function FollowUpsForPatient({ patientId }) {
  const list = useQuery({
    queryKey: ['doctor-follow-ups', 'all'],
    queryFn: () => followUpApi.forDoctor(),
  });
  const mine = (list.data ?? []).filter((f) => f.patientId === patientId);
  return (
    <Card>
      <SectionHeader
        icon={HeartPulse}
        title="Follow-ups"
        actions={
          <ButtonLink as={Link} to="/app/follow-ups" variant="subtle" size="sm">
            All follow-ups
          </ButtonLink>
        }
      />
      {list.isSuccess && mine.length === 0 && (
        <p className="mt-2 text-sm text-text-muted">No follow-ups with this patient.</p>
      )}
      <ul className="mt-2 divide-y divide-border">
        {mine.map((f) => (
          <li key={f.id} className="flex items-center justify-between gap-2 py-2 text-sm">
            <Link to={`/app/follow-ups?open=${f.id}`} className="text-text hover:text-primary">
              Due {formatDateOnly(f.dueOn)}
            </Link>
            <StatusBadge status={f.status} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function DoctorPatientRecordsPage() {
  const { patientId } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = RECORD_TABS.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'overview';
  const shared = useSharedRecords();
  const consent = shared.byPatient.get(patientId);
  const patients = useQuery({
    queryKey: ['doctors', 'patients'],
    queryFn: () => doctorsApi.myPatients(),
  });
  const rel = (patients.data ?? []).find((r) => r.patient?.id === patientId);
  const name = rel?.patient.fullName ?? consent?.patientName ?? 'Patient';
  const age = ageFrom(rel?.patient.dateOfBirth);
  const documents = useQuery({
    queryKey: ['documents', patientId],
    queryFn: () => recordsApi.list(patientId),
    retry: false,
  });
  const download = useDownload();
  const noConsent = documents.error?.code === 'consent_required';
  return (
    <div className="space-y-6">
      <BackLink to="/app/medical-records">Patient Records</BackLink>
      <PageHeader
        icon={FolderOpen}
        eyebrow="Patient record"
        title={name}
        description={
          consent
            ? `${age !== null ? `${age} years · ` : ''}Shared with you: ${consent.scopes
                .map((sc) => SCOPE_LABELS[sc])
                .join(
                  ', ',
                )} · until ${formatDateTime(consent.expiresAt)}. Access ends at once if the patient revokes it.`
            : 'Only what this patient has shared with you is shown.'
        }
      />
      {documents.isPending && <LoadingState label="Loading shared records" rows={2} />}
      {noConsent && (
        <ConsentRequiredNotice>
          This patient has not given you access to their documents, or the access has ended. Only
          the patient can share their records.
        </ConsentRequiredNotice>
      )}
      {documents.isError && !noConsent && (
        <Alert tone="error">{authErrorMessage(documents.error)}</Alert>
      )}
      {download.isError && <Alert tone="error">{authErrorMessage(download.error)}</Alert>}
      <UpcomingWithPatient patientId={patientId} />
      {documents.isSuccess && (
        <>
          <Tabs
            label="Patient record"
            value={tab}
            onChange={(t) => setParams(t === 'overview' ? {} : { tab: t }, { replace: true })}
            tabs={RECORD_TABS}
          />
          {tab === 'overview' && (
            <div className="grid gap-6 lg:grid-cols-2">
              <Card>
                <SectionHeader
                  icon={FlaskConical}
                  title="Verified lab values"
                  description="Values a doctor has checked against the source document."
                  className="mb-3"
                />
                <LabResults patientId={patientId} />
              </Card>
              <FollowUpsForPatient patientId={patientId} />
              <Card className="lg:col-span-2">
                <SectionHeader icon={Pill} title="Previous prescriptions" className="mb-3" />
                <PatientPrescriptions patientId={patientId} audience="doctor" />
              </Card>
            </div>
          )}
          {tab === 'documents' && (
            <Card>
              {documents.data.length === 0 ? (
                <EmptyState compact icon={FileText} title="No documents shared">
                  The patient has not uploaded documents, or none of the shared kinds.
                </EmptyState>
              ) : (
                <DocumentList
                  documents={documents.data}
                  download={download}
                  renderDetails={(d) => <ReviewValues documentId={d.id} />}
                />
              )}
            </Card>
          )}
          {tab === 'timeline' && (
            <Card>
              <Timeline patientId={patientId} />
            </Card>
          )}
          {tab === 'ask' && (
            <Card>
              <AskRecords patientId={patientId} />
            </Card>
          )}
        </>
      )}
    </div>
  );
}
