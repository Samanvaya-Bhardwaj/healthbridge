import { Lock, ShieldAlert } from 'lucide-react';
import { Skeleton } from './Skeleton.jsx';

/**
 * Empty and first-use states. Always: a short title, one or two sentences of context,
 * and (when there is one) the primary next action.
 * `compact` is for empty sections inside a page; the default is for a whole page or panel.
 */
export function EmptyState({ icon: Icon, title, children, action, compact = false }) {
  if (compact) {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-dashed border-border px-4 py-4">
        {Icon && <Icon aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-text-subtle" />}
        <div className="min-w-0 text-sm">
          <p className="font-medium text-text">{title}</p>
          {children && <div className="mt-0.5 text-text-muted">{children}</div>}
          {action && <div className="mt-3">{action}</div>}
        </div>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-md rounded-2xl border border-dashed border-border px-6 py-12 text-center">
      {Icon && (
        <span
          aria-hidden="true"
          className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary-soft text-primary"
        >
          <Icon className="h-6 w-6" />
        </span>
      )}
      <h2 className="text-base font-semibold text-text">{title}</h2>
      {children && <div className="mt-2 text-sm leading-relaxed text-text-muted">{children}</div>}
      {action && <div className="mt-6 flex justify-center">{action}</div>}
    </div>
  );
}

/** You are signed in, but your role does not include this. */
export function PermissionNotice({ title = 'Not available for your role', children, action }) {
  return (
    <EmptyState icon={Lock} title={title} action={action}>
      {children ??
        'Your account’s role doesn’t include this. If you think this is a mistake, contact your clinic or HealthBridge support.'}
    </EmptyState>
  );
}

/** A doctor needs the patient's active consent before seeing these records. */
export function ConsentRequiredNotice({ title = 'Consent required', children, action, compact }) {
  return (
    <EmptyState icon={ShieldAlert} title={title} action={action} compact={compact}>
      {children ??
        'The patient hasn’t shared these records with you, or their consent has expired or been revoked. Only the patient can grant access.'}
    </EmptyState>
  );
}

/** Loading placeholder with an announced label (skeleton lines are hidden from screen readers). */
export function LoadingState({ label = 'Loading', rows = 3, className = '' }) {
  return (
    <div role="status" className={`space-y-3 ${className}`}>
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={`block h-12 ${i % 2 ? 'w-5/6' : 'w-full'}`} />
      ))}
    </div>
  );
}
