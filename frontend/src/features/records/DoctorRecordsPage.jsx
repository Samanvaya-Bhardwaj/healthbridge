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
import { Timeline } from './Timeline.jsx';
import { useDownload } from './useDownload.js';
import { SCOPE_LABELS } from './labels.js';

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
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-text">Medical records</h1>
        <p className="mt-2 text-text-muted">
          Records your patients have chosen to share with you. Access ends when they revoke it or it
          expires.
        </p>
      </div>
      {received.isPending && <Skeleton className="h-24 w-full" />}
      {received.isError && <Alert tone="error">{authErrorMessage(received.error)}</Alert>}
      {received.isSuccess && active.length === 0 && (
        <EmptyState title="No shared records">
          Patients can share records with you from their Privacy &amp; Access page.
        </EmptyState>
      )}
      <ul className="space-y-3">
        {active.map((c) => (
          <li key={c.id}>
            <Card>
              <Link to={`/app/medical-records/${c.patientId}`} className="font-medium text-primary">
                {c.patientName}
              </Link>
              <p className="mt-1 text-sm text-text-muted">
                {c.scopes.map((s) => SCOPE_LABELS[s]).join(', ')} · until{' '}
                {formatDateTime(c.expiresAt)}
              </p>
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
      <Link to="/app/medical-records" className="text-sm font-medium text-primary">
        ← Medical records
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight text-text">Shared documents</h1>
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
          <h2 className="mb-2 text-sm font-semibold text-text">Timeline</h2>
          <Timeline patientId={patientId} />
        </Card>
      )}
    </div>
  );
}
