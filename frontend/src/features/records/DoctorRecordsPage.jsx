import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { consentsApi, recordsApi } from '../../lib/domainApi.js';
import { authErrorMessage } from '../auth/errorMessages.js';
import { Card } from '../../components/ui/Card.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { Skeleton } from '../../components/ui/Skeleton.jsx';
import { EmptyState } from '../../components/ui/EmptyState.jsx';
import { formatDateTime } from '../appointments/format.js';
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

export function DoctorPatientRecordsPage() {
  const { patientId } = useParams();
  const documents = useQuery({
    queryKey: ['documents', patientId],
    queryFn: () => recordsApi.list(patientId),
    retry: false,
  });
  const download = useDownload();
  return (
    <div className="space-y-6">
      <BackLink to="/app/medical-records">Patient Records</BackLink>
      <PageHeader
        icon={FolderOpen}
        eyebrow="Patients"
        title="Shared records"
        description="Documents, verified lab values, prescriptions and timeline this patient has shared with you. Access ends when they revoke it or it expires."
      />
      {documents.isPending && <Skeleton className="h-24 w-full" />}
      {documents.isError && (
        <Alert tone="error">
          {documents.error?.code === 'consent_required'
            ? 'This patient has not given you access to their documents, or the access has ended.'
            : authErrorMessage(documents.error)}
        </Alert>
      )}
      {download.isError && <Alert tone="error">{authErrorMessage(download.error)}</Alert>}
      {documents.data?.length === 0 && (
        <EmptyState title="No documents">Nothing has been shared yet.</EmptyState>
      )}
      {documents.data?.length > 0 && (
        <Card>
          <DocumentList
            documents={documents.data}
            download={download}
            renderDetails={(d) => (
              <details className="mt-2">
                <summary className="cursor-pointer text-sm text-primary">
                  Review extracted values
                </summary>
                <div className="mt-2">
                  <ExtractionPanel documentId={d.id} canVerify />
                </div>
              </details>
            )}
          />
        </Card>
      )}
      {documents.isSuccess && (
        <Card>
          <h2 className="mb-2 text-sm font-semibold text-text">Verified lab values</h2>
          <LabResults patientId={patientId} />
        </Card>
      )}
      {documents.isSuccess && (
        <Card>
          <h2 className="mb-2 text-sm font-semibold text-text">Prescriptions</h2>
          <PatientPrescriptions patientId={patientId} />
        </Card>
      )}
      {documents.isSuccess && (
        <Card>
          <AskRecords patientId={patientId} />
        </Card>
      )}
      {documents.isSuccess && (
        <Card>
          <h2 className="mb-2 text-sm font-semibold text-text">Timeline</h2>
          <Timeline patientId={patientId} />
        </Card>
      )}
    </div>
  );
}
