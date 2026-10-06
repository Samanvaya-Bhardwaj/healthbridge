import { LogoMark } from './Logo.jsx';

export function Spinner({ label = 'Loading', className = '' }) {
  return (
    <span role="status" className={`inline-flex items-center gap-2 text-text-muted ${className}`}>
      <span
        aria-hidden="true"
        className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-primary"
      />
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** Start-up screen while the session is restored: never a blank page, even on a slow network. */
export function FullPageSpinner({ label }) {
  return (
    <div
      role="status"
      className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-surface px-4 text-center"
    >
      <LogoMark className="h-12 w-12" />
      <span className="inline-flex items-center gap-2 text-sm text-text-muted">
        <span
          aria-hidden="true"
          className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-primary"
        />
        {label}…
      </span>
    </div>
  );
}
