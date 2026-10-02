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
import {
  ACCEPT,
  DOCUMENT_TYPE_LABELS,
  contentTypeFor,
  postToStorage,
  sha256Hex,
} from './upload.js';

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
      <h2 className="text-sm font-semibold text-text">Add a document</h2>
      <p className="mt-1 text-sm text-text-muted">
        PDF, PNG or JPEG up to 10 MB. Every file is checked for safety before it is added to your
        record.
      </p>
      <form
        className="mt-4 grid gap-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (file) upload.mutate();
        }}
      >
        <SelectField
          label="Type"
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
        <div className="sm:col-span-2">
          <label htmlFor="record-file" className="block text-sm font-medium text-text">
            File
          </label>
          <input
            id="record-file"
            type="file"
            accept={ACCEPT}
            className="mt-1.5 block w-full text-sm text-text-muted"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </div>
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
          <Button type="submit" disabled={!file || upload.isPending}>
            {upload.isPending ? 'Uploading…' : 'Upload'}
          </Button>
        </div>
      </form>
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

  if (isPending) return <Skeleton className="h-40 w-full" />;
  if (missingProfile) return <Alert tone="info">Create your patient profile first.</Alert>;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-text">Health records</h1>
          <p className="mt-2 text-text-muted">
            Your documents stay private. Doctors see them only when you give them access.
          </p>
        </div>
        <PatientSelect choices={choices} value={patientId} onChange={setPatientId} />
      </div>
      <UploadForm patientId={patientId} onUploaded={refresh} />
      {download.isError && <Alert tone="error">{authErrorMessage(download.error)}</Alert>}
      {remove.isError && <Alert tone="error">{authErrorMessage(remove.error)}</Alert>}
      <Card>
        <h2 className="text-sm font-semibold text-text">Documents</h2>
        {documents.isPending && <Skeleton className="mt-4 h-20 w-full" />}
        {documents.isError && <Alert tone="error">{authErrorMessage(documents.error)}</Alert>}
        {documents.data?.length === 0 && (
          <EmptyState title="No documents yet">
            Upload a report or prescription to start.
          </EmptyState>
        )}
        {documents.data?.length > 0 && (
          <DocumentList
            documents={documents.data}
            download={download}
            onRemove={(id) => remove.mutate(id)}
            removing={remove.isPending}
          />
        )}
      </Card>
    </div>
  );
}
