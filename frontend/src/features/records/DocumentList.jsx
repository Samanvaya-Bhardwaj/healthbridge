import { Button } from '../../components/ui/Button.jsx';
import { StatusBadge } from '../../components/ui/Badge.jsx';
import { formatDateTime } from '../appointments/format.js';
import { DOCUMENT_TYPE_LABELS, REJECTION_LABELS, STATUS_HINTS, formatBytes } from './upload.js';
import { Download, FileText, FlaskConical, ScanLine, ShieldCheck } from 'lucide-react';

/** Document metadata list; download goes through `useDownload` (short-lived URLs). */
export function DocumentList({ documents, onRemove, removing, download, renderDetails }) {
  return (
    <ul className="divide-y divide-border">
      {documents.map((d) => (
        <li key={d.id} className="py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 gap-3">
              <span
                aria-hidden="true"
                className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary"
              >
                {d.documentType === 'lab_report' ? (
                  <FlaskConical className="h-4 w-4" />
                ) : d.documentType === 'imaging' ? (
                  <ScanLine className="h-4 w-4" />
                ) : (
                  <FileText className="h-4 w-4" />
                )}
              </span>
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 font-medium text-text">
                  {d.title}
                  <StatusBadge status={d.status} />
                </p>
                <p className="mt-0.5 text-sm text-text-muted">
                  {DOCUMENT_TYPE_LABELS[d.documentType]} · {formatDateTime(d.createdAt)} ·{' '}
                  {formatBytes(d.sizeBytes)}
                  {d.uploadedBy?.name && ` · uploaded by ${d.uploadedBy.name}`}
                </p>
                {d.status === 'available' ? (
                  <p className="mt-0.5 flex items-center gap-1 text-sm text-success">
                    <ShieldCheck aria-hidden="true" className="h-4 w-4" />
                    {STATUS_HINTS.available}
                  </p>
                ) : d.status === 'rejected' ? (
                  <p className="mt-0.5 text-sm text-danger">
                    {REJECTION_LABELS[d.rejectionReason] ?? 'The file was not accepted.'}{' '}
                    <span className="text-text-muted">
                      Nothing from it was added to your record. You can upload the file again or
                      choose another one.
                    </span>
                  </p>
                ) : (
                  <p className="mt-0.5 text-sm text-text-muted">{STATUS_HINTS[d.status]}</p>
                )}
              </div>
            </div>
            <div className="flex gap-2">
              {d.status === 'available' && (
                <Button
                  variant="secondary"
                  icon={Download}
                  onClick={() => download.mutate(d.id)}
                  disabled={download.isPending}
                >
                  Download
                </Button>
              )}
              {onRemove && ['available', 'rejected'].includes(d.status) && (
                <Button variant="ghost" onClick={() => onRemove(d.id)} disabled={removing}>
                  Remove
                </Button>
              )}
            </div>
          </div>
          {renderDetails && d.status === 'available' && renderDetails(d)}
        </li>
      ))}
    </ul>
  );
}
