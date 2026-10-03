/**
 * Typography for HealthBridge (design system).
 *
 *   PageHeader     where am I (eyebrow + title), what is this page for (description),
 *                  and the page's main actions. One per page; renders the only <h1>.
 *   SectionHeader  a titled group inside a page (h2 by default).
 *   HelperText     secondary explanation under a control or block.
 *   ErrorText      inline error, announced to assistive technology.
 *
 * Sizes: page title 1.5rem semibold, section 1rem semibold, body 1rem, secondary 0.875rem.
 */

export function PageHeader({ icon: Icon, eyebrow, title, description, actions, children }) {
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 gap-4">
        {Icon && (
          <span
            aria-hidden="true"
            className="hidden h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary sm:flex"
          >
            <Icon className="h-5 w-5" />
          </span>
        )}
        <div className="min-w-0">
          {eyebrow && <p className="text-sm font-medium text-primary">{eyebrow}</p>}
          <h1 className="text-2xl font-semibold tracking-tight text-text">{title}</h1>
          {description && <p className="mt-1.5 max-w-2xl text-text-muted">{description}</p>}
          {children}
        </div>
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
        <Heading id={id} className="flex items-center gap-2 text-base font-semibold text-text">
          {Icon && <Icon aria-hidden="true" className="h-4 w-4 text-primary" />}
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
