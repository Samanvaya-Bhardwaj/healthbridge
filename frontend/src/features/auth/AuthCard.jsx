/** Centered card used by the sign-in and registration pages. */
export function AuthCard({ title, subtitle, children, footer }) {
  return (
    <div className="mx-auto w-full max-w-md px-6 py-12 sm:py-20">
      <h1 className="text-2xl font-semibold tracking-tight text-text">{title}</h1>
      {subtitle && <p className="mt-2 text-text-muted">{subtitle}</p>}
      <div className="mt-8 rounded-2xl border border-border bg-surface-raised p-6 sm:p-8">
        {children}
      </div>
      {footer && <p className="mt-6 text-center text-sm text-text-muted">{footer}</p>}
    </div>
  );
}
