/**
 * Typography for HealthBridge (design system).
 *
 *   PageHeader     where am I (eyebrow + title), what is this page for (description),
 *                  and the page's main actions. One per page; renders the only <h1>.
 *   SectionHeader  a titled group inside a page (h2 by default).
 *   HelperText     secondary explanation under a control or block.
 *   ErrorText      inline error, announced to assistive technology.
 *
 * Sizes: page title 2rem medium (tight), section 1.125rem medium, body 1rem, secondary
 * 0.875rem. Eyebrows and labels use the mono voice: small, uppercase, spaced.
 */

/** A small mono label, with the sky dot of "where you are". */
export function Eyebrow({ icon: Icon, children, className = '' }) {
  return (
    <p
      className={`flex items-center gap-2 font-mono text-[0.6875rem] font-medium uppercase tracking-[0.1em] text-primary ${className}`}
    >
      {Icon ? (
        <Icon aria-hidden="true" className="h-3.5 w-3.5" />
      ) : (
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent" />
      )}
      {children}
    </p>
  );
}

export function PageHeader({ icon: Icon, eyebrow, title, description, actions, children }) {
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {eyebrow && <Eyebrow icon={Icon}>{eyebrow}</Eyebrow>}
        <h1 className="mt-2 text-[1.875rem] font-medium leading-[1.15] tracking-[-0.02em] text-text sm:text-[2.125rem]">
          {title}
        </h1>
        {description && (
          <p className="mt-2.5 max-w-2xl leading-relaxed text-text-muted">{description}</p>
        )}
        {children}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
    </header>
  );
}

export function SectionHeader({
  as: Heading = 'h2',
  icon: Icon,
  title,
  description,
  actions,
  className = '',
  id,
}) {
  return (
    <div className={`flex flex-wrap items-start justify-between gap-3 ${className}`}>
      <div className="min-w-0">
        <Heading
          id={id}
          className="flex items-center gap-2.5 text-[1.125rem] font-medium tracking-[-0.01em] text-text"
        >
          {Icon && (
            <span
              aria-hidden="true"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary"
            >
              <Icon className="h-4 w-4" />
            </span>
          )}
          {title}
        </Heading>
        {description && <p className="mt-1 text-sm text-text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function HelperText({ id, children, className = '' }) {
  return (
    <p id={id} className={`text-sm text-text-subtle ${className}`}>
      {children}
    </p>
  );
}

export function ErrorText({ id, children, className = '' }) {
  return (
    <p id={id} className={`text-sm text-danger ${className}`}>
      {children}
    </p>
  );
}
