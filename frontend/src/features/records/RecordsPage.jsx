import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DOCUMENT_TYPES } from '@healthbridge/shared';
import { recordsApi } from '../../lib/domainApi.js';
import { authErrorMessage } from '../auth/errorMessages.js';
import { Card } from '../../components/ui/Card.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { Skeleton } from '../../components/ui/Skeleton.jsx';
import { EmptyState } from '../../components/ui/EmptyState.jsx';
import { TextField } from '../../components/ui/TextField.jsx';
import { SelectField } from '../../components/ui/SelectField.jsx';
import { usePatientChoice } from './usePatientChoice.js';
import { PatientSelect } from './PatientSelect.jsx';
import { DocumentList } from './DocumentList.jsx';
import { useDownload } from './useDownload.js';
import { ExtractionPanel, LabResults } from './ExtractionPanel.jsx';
import { PatientPrescriptions } from '../consultations/Prescriptions.jsx';
import { intelligenceApi } from '../../lib/domainApi.js';
import {
  ACCEPT,
  DOCUMENT_TYPE_LABELS,
  contentTypeFor,
  postToStorage,
  sha256Hex,
} from './upload.js';
import { PageHeader } from '../../components/ui/Typography.jsx';
import { CheckboxField, FileField } from '../../components/ui/Fields.jsx';
import { SectionHeader } from '../../components/ui/Typography.jsx';
import { MissingProfileNotice } from '../patients/MissingProfileNotice.jsx';
import { useConfirm } from '../../components/ui/useConfirm.jsx';
import { LoadingState } from '../../components/ui/EmptyState.jsx';
import { FileText, FlaskConical, FolderHeart, Pill, Sparkles, Upload } from 'lucide-react';

const IN_PROGRESS = new Set(['pending_upload', 'quarantined', 'scanning']);
const MAX_BYTES = 10 * 1024 * 1024; // mirrors the server default; the server decides

function UploadForm({ patientId, onUploaded }) {
  const [file, setFile] = useState(null);
  const [title, setTitle] = useState('');
  const [documentType, setDocumentType] = useState('lab_report');
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);

  const upload = useMutation({
    mutationFn: async () => {
      const contentType = contentTypeFor(file.name);
      if (!contentType) throw new Error('Choose a PDF, PNG or JPEG file.');
      if (file.size > MAX_BYTES) throw new Error('Files can be at most 10 MB.');
      setProgress(0);
      const intent = await recordsApi.uploadIntent(patientId, {
        documentType,
        title: title.trim() || file.name.replace(/\.[^.]+$/, ''),
        filename: file.name,
        contentType,
        sizeBytes: file.size,
        sha256: await sha256Hex(file),
      });
      await postToStorage(intent.upload, file, setProgress);
      return recordsApi.complete(intent.document.id);
    },
    onSuccess: () => {
      setFile(null);
      setTitle('');
      setProgress(null);
      setError(null);
      onUploaded();
    },
    onError: (err) => {
      setProgress(null);
      setError(err.status ? authErrorMessage(err) : err.message);
    },
  });

  return (
    <Card>
      <SectionHeader
        icon={Upload}
        title="Add a document"
        description="Lab reports, prescriptions, scans or discharge summaries. Every file is checked for safety before it is added to your record."
      />
      <form
        className="mt-4 grid gap-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (file) upload.mutate();
        }}
      >
        <SelectField
          label="Type"
          hint="What kind of document this is."
          value={documentType}
          onChange={(e) => setDocumentType(e.target.value)}
          options={DOCUMENT_TYPES.map((t) => ({ value: t, label: DOCUMENT_TYPE_LABELS[t] }))}
        />
        <TextField
          label="Name"
          value={title}
          maxLength={120}
          onChange={(e) => setTitle(e.target.value)}
          hint="Optional — shown in your records list."
        />
        <FileField
          className="sm:col-span-2"
          label="File"
          hint="PDF, PNG or JPEG, up to 10 MB."
          accept={ACCEPT}
          fileName={file?.name}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        {progress !== null && (
          <div className="sm:col-span-2">
            <progress className="w-full" max={1} value={progress} aria-label="Upload progress" />
          </div>
        )}
        {error && (
          <Alert tone="error" className="sm:col-span-2">
            {error}
          </Alert>
        )}
        <div className="sm:col-span-2">
          <Button type="submit" icon={Upload} disabled={!file} loading={upload.isPending}>
            {upload.isPending ? 'Uploading…' : 'Upload'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** Opt-in for AI reading of documents (off by default; per patient). */
function AiProcessingCard({ patientId }) {
  const queryClient = useQueryClient();
  const setting = useQuery({
    queryKey: ['ai-processing', patientId],
    queryFn: () => intelligenceApi.aiProcessing(patientId),
    enabled: Boolean(patientId),
  });
  const toggle = useMutation({
    mutationFn: (enabled) => intelligenceApi.setAiProcessing(patientId, enabled),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ai-processing', patientId] }),
  });
  if (!setting.data) return null;
  return (
    <Card className="border-primary/20">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary"
        >
          <Sparkles className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-primary">
            AI assistance · optional
          </p>
          <CheckboxField
            label="Read my documents to suggest key values"
            description="HealthBridge AI reads your documents to pull out values such as test results, each with the exact text it came from. They stay suggestions until a doctor you shared them with verifies them. AI never diagnoses. You can switch this off at any time."
            checked={setting.data.enabled}
            disabled={toggle.isPending}
            onChange={(e) => toggle.mutate(e.target.checked)}
          />
        </div>
      </div>
    </Card>
  );
}

/** Patient (and managing guardian) health records. */
export function RecordsPage() {
  const queryClient = useQueryClient();
  const { choices, patientId, setPatientId, isPending, missingProfile } = usePatientChoice();
  const documents = useQuery({
    queryKey: ['documents', patientId],
    queryFn: () => recordsApi.list(patientId),
    enabled: Boolean(patientId),
    // Poll while a document is uploading or being checked.
    refetchInterval: (query) =>
      query.state.data?.some((d) => IN_PROGRESS.has(d.status)) ? 2_000 : false,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['documents', patientId] });
  const remove = useMutation({ mutationFn: recordsApi.retire, onSuccess: refresh });
  const download = useDownload();
  const { confirm, dialog } = useConfirm();
  const confirmRemove = async (id) => {
    const ok = await confirm({
      title: 'Remove this document from your records?',
      description:
        'It disappears from your records and from doctors you shared it with. For safety it is retired, not destroyed, so it stays in the audit history.',
      confirmLabel: 'Remove document',
      destructive: true,
    });
    if (ok) remove.mutate(id);
  };

  if (isPending) return <Skeleton className="h-40 w-full" />;
  if (missingProfile) return <MissingProfileNotice />;

  return (
    <div className="space-y-6">
      <PageHeader
        icon={FileText}
        eyebrow="My health"
        title="Health Records"
        description="Upload reports and documents so your doctors can see your history. Files stay private: every upload is checked for safety, and doctors see it only when you give them access in Privacy & Access."
        actions={<PatientSelect choices={choices} value={patientId} onChange={setPatientId} />}
      />
      <AiProcessingCard patientId={patientId} />
      <UploadForm patientId={patientId} onUploaded={refresh} />
      {download.isError && <Alert tone="error">{authErrorMessage(download.error)}</Alert>}
      {remove.isError && <Alert tone="error">{authErrorMessage(remove.error)}</Alert>}
      <Card>
        {dialog}
        <SectionHeader icon={FolderHeart} title="Documents" />
        {documents.isPending && (
          <LoadingState label="Loading documents" rows={2} className="mt-4" />
        )}
        {documents.isError && <Alert tone="error">{authErrorMessage(documents.error)}</Alert>}
        {documents.data?.length === 0 && (
          <div className="mt-3">
            <EmptyState compact icon={FileText} title="No documents yet">
              Use “Add a document” above to upload a lab report, prescription or scan. Your doctors
              see it only when you share it with them.
            </EmptyState>
          </div>
        )}
        {documents.data?.length > 0 && (
          <DocumentList
            renderDetails={(d) => (
              <details className="mt-2">
                <summary className="cursor-pointer text-sm text-primary">Extracted values</summary>
                <div className="mt-2">
                  <ExtractionPanel documentId={d.id} />
                </div>
              </details>
            )}
            documents={documents.data}
            download={download}
            onRemove={confirmRemove}
            removing={remove.isPending}
          />
        )}
      </Card>
      <Card>
        <SectionHeader
          icon={FlaskConical}
          title="Verified lab values"
          description="Values a doctor has checked against your reports."
          className="mb-3"
        />
        <LabResults patientId={patientId} />
      </Card>
      <Card>
        <SectionHeader icon={Pill} title="Prescriptions" className="mb-3" />
        <PatientPrescriptions patientId={patientId} />
      </Card>
    </div>
  );
}
