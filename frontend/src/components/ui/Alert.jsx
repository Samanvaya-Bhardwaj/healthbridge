const tones = {
  info: 'border-border bg-primary-soft text-text',
  success: 'border-border bg-primary-soft text-text',
  error: 'border-danger/40 bg-danger/5 text-text',
};

/** Inline status message. Errors are announced assertively, others politely. */
export function Alert({ tone = 'info', title, children, className = '' }) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`rounded-lg border px-4 py-3 text-sm ${tones[tone]} ${className}`}
    >
      {title && <p className="font-medium">{title}</p>}
      {children && <div className={title ? 'mt-1 text-text-muted' : ''}>{children}</div>}
    </div>
  );
}
