/** Calm placeholder with a single clear message and optional action. */
export function EmptyState({ title, children, action }) {
  return (
    <div className="mx-auto max-w-md rounded-2xl border border-dashed border-border px-6 py-14 text-center">
      <h2 className="text-base font-semibold text-text">{title}</h2>
      {children && <div className="mt-2 text-sm leading-relaxed text-text-muted">{children}</div>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
