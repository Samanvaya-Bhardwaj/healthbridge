import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DOCUMENT_TYPES } from '@healthbridge/shared';
import { recordsApi } from '../../lib/domainApi.js';
import { authErrorMessage } from '../auth/errorMessages.js';
import { Card } from '../../components/ui/Card.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { Button, ButtonLink } from '../../components/ui/Button.jsx';
import { Skeleton } from '../../components/ui/Skeleton.jsx';
import { EmptyState } from '../../components/ui/EmptyState.jsx';
import { TextField } from '../../components/ui/TextField.jsx';
import { SelectField } from '../../components/ui/SelectField.jsx';
import { usePatientChoice } from './usePatientChoice.js';
import { PatientSelect } from './PatientSelect.jsx';
import { DocumentList } from './DocumentList.jsx';
import { useDownload } from './useDownload.js';
import { ExtractionPanel, LabResults } from './ExtractionPanel.jsx';
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
  const [done, setDone] = useState(null);

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
    onSuccess: (document) => {
      setDone(document?.title ?? 'Your document');
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
          setDone(null);
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
        {done && (
          <Alert tone="success" className="sm:col-span-2">
            “{done}” was uploaded. It shows as Processing while we check it for safety, then as
            Available. Doctors see it only if you share your records with them.
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
    <Card className="border-ai/25">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-ai-soft text-ai"
        >
          <Sparkles className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ai">
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

/** AI-suggested values for one document, loaded (and audited) only when opened. */
function AiValues({ documentId }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="mt-2" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cursor-pointer text-sm text-primary">Values suggested by AI</summary>
      {open && (
        <div className="mt-2">
          <ExtractionPanel documentId={documentId} />
        </div>
      )}
    </details>
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
  // AI-suggested values exist only when the patient turned AI reading on.
  const aiSetting = useQuery({
    queryKey: ['ai-processing', patientId],
    queryFn: () => intelligenceApi.aiProcessing(patientId),
    enabled: Boolean(patientId),
  });
  const aiEnabled = Boolean(aiSetting.data?.enabled);
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
            renderDetails={(d) => aiEnabled && <AiValues documentId={d.id} />}
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
      <AiProcessingCard patientId={patientId} />
      <Card className="flex flex-wrap items-center justify-between gap-3">
        <SectionHeader
          icon={Pill}
          title="Prescriptions"
          description="Prescriptions your doctors sign have their own page, ready to download."
        />
        <ButtonLink as={Link} to="/app/prescriptions" variant="secondary" icon={Pill}>
          Open prescriptions
        </ButtonLink>
      </Card>
    </div>
  );
}
