/** Placeholder block shown while content loads. Hidden from assistive technology. */
export function Skeleton({ className = '' }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block animate-pulse rounded-md bg-surface-muted ${className}`}
    />
  );
}
