import { useState } from 'react';
import { ShieldOff } from 'lucide-react';
import { Alert } from '../../components/ui/Alert.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { CheckboxField, SelectField, TextAreaField } from '../../components/ui/Fields.jsx';
import { Dialog } from '../../components/ui/Dialog.jsx';
import { authErrorMessage } from '../auth/errorMessages.js';

/** The platform role boundary, stated wherever administrators work. */
export function PlatformBoundary({ compact = false }) {
  return (
    <div
      className={`flex items-start gap-3 rounded-xl border border-border bg-surface-muted ${
        compact ? 'px-3 py-2 text-xs' : 'px-4 py-3 text-sm'
      } text-text-muted`}
    >
      <ShieldOff aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-text-subtle" />
      <p>
        <span className="font-medium text-text">
          Platform administrators do not have access to clinical records.
        </span>{' '}
        Administration covers accounts, doctor verification, clinics, the audit trail and background
        jobs. Medical records, notes, prescriptions, lab results and AI output never appear here.
      </p>
    </div>
  );
}

/**
 * Confirmation for consequential actions. When `reasons` is given, a reason is required
 * (as the backend requires). `acknowledge` adds a checkbox the admin must tick.
 */
export function ActionDialog({
  title,
  description,
  confirmLabel,
  reasons,
  reasonLabel = 'Reason',
  notes = false,
  acknowledge,
  destructive = false,
  pending = false,
  error,
  onConfirm,
  onClose,
}) {
  const [reason, setReason] = useState('');
  const [text, setText] = useState('');
  const [ack, setAck] = useState(false);
  const ready = (!reasons || reason) && (!acknowledge || ack);
  return (
    <Dialog
      open
      title={title}
      description={description}
      tone={destructive ? 'warning' : undefined}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Go back
          </Button>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            disabled={!ready}
            loading={pending}
            onClick={() =>
              onConfirm({ reasonCode: reason || undefined, notes: text.trim() || undefined })
            }
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {reasons && (
          <SelectField
            label={reasonLabel}
            placeholder="Choose a reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            options={reasons}
          />
        )}
        {notes && (
          <TextAreaField
            label="Internal notes (optional)"
            hint="Seen by administrators only. Don’t include patient information."
            rows={3}
            maxLength={1000}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        )}
        {acknowledge && (
          <CheckboxField
            label={acknowledge}
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
          />
        )}
        {error && <Alert tone="error">{authErrorMessage(error)}</Alert>}
      </div>
    </Dialog>
  );
}
