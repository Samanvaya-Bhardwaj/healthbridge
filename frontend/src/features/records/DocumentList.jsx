import { Button } from '../../components/ui/Button.jsx';
import { StatusBadge } from '../../components/ui/Badge.jsx';
import { formatDateTime } from '../appointments/format.js';
import { DOCUMENT_TYPE_LABELS, REJECTION_LABELS, STATUS_HINTS, formatBytes } from './upload.js';

/** Document metadata list; download goes through `useDownload` (short-lived URLs). */
export function DocumentList({ documents, onRemove, removing, download, renderDetails }) {
  return (
    <ul className="divide-y divide-border">
      {documents.map((d) => (
        <li key={d.id} className="py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="flex flex-wrap items-center gap-2 font-medium text-text">
                {d.title}
                <StatusBadge status={d.status === 'available' ? 'active' : d.status} />
              </p>
              <p className="mt-0.5 text-sm text-text-muted">
                {DOCUMENT_TYPE_LABELS[d.documentType]} · {formatDateTime(d.createdAt)} ·{' '}
                {formatBytes(d.sizeBytes)}
                {d.uploadedBy?.name && ` · uploaded by ${d.uploadedBy.name}`}
              </p>
              {d.status !== 'available' && (
                <p className="mt-0.5 text-sm text-text-subtle">
                  {d.status === 'rejected'
                    ? (REJECTION_LABELS[d.rejectionReason] ?? 'Not accepted.')
                    : STATUS_HINTS[d.status]}
                </p>
              )}
            </div>
            <div className="flex gap-2">
              {d.status === 'available' && (
                <Button
                  variant="secondary"
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
