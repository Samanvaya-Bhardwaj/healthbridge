const base =
  'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium ' +
  'transition-colors disabled:cursor-not-allowed disabled:opacity-60 min-h-11';

const variants = {
  primary: 'bg-primary text-primary-contrast hover:bg-primary-hover',
  secondary: 'border border-border bg-surface-raised text-text hover:bg-surface-muted',
  ghost: 'text-text-muted hover:bg-surface-muted hover:text-text',
  danger: 'bg-danger text-white hover:opacity-90',
};

/**
 * @param {{ variant?: keyof typeof variants, type?: 'button' | 'submit' | 'reset' } & import('react').ButtonHTMLAttributes<HTMLButtonElement>} props
 */
export function Button({ variant = 'primary', type = 'button', className = '', ...props }) {
  return <button type={type} className={`${base} ${variants[variant]} ${className}`} {...props} />;
}
