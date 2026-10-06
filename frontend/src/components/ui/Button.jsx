import { Loader2 } from 'lucide-react';

const base =
  'inline-flex items-center justify-center gap-2 rounded-full font-medium transition-colors ' +
  'disabled:cursor-not-allowed disabled:opacity-60';

const sizes = {
  md: 'min-h-11 px-5 py-2.5 text-sm',
  sm: 'min-h-9 px-3.5 py-1.5 text-sm',
};

const variants = {
  primary: 'bg-primary text-primary-contrast hover:bg-primary-hover',
  secondary:
    'border border-border bg-surface-raised text-text hover:border-primary/40 hover:bg-primary-soft/60',
  ghost: 'text-text-muted hover:bg-surface-muted hover:text-text',
  danger: 'bg-danger text-white hover:opacity-90',
  // AI assistance: its own quiet colour, so it reads as a helper, not the main action.
  ai: 'border border-ai/25 bg-ai-soft text-ai hover:border-ai/50',
};
// Design-system names; the original names stay valid.
variants.destructive = variants.danger;
variants.subtle = variants.ghost;

/**
 * Buttons: primary (the one main action of an area), secondary, subtle/ghost and
 * destructive/danger. `icon` is a lucide component shown before the label. `loading`
 * disables the button and shows a spinner in place of the icon, keeping the label so the
 * button does not change size.
 * @param {{ variant?: keyof typeof variants, size?: 'md' | 'sm', icon?: import('react').ComponentType<any>, loading?: boolean, type?: 'button' | 'submit' | 'reset' } & import('react').ButtonHTMLAttributes<HTMLButtonElement>} props
 */
export function Button({
  variant = 'primary',
  size = 'md',
  icon: Icon,
  loading = false,
  type = 'button',
  className = '',
  disabled,
  children,
  ...props
}) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`${base} ${sizes[size]} ${variants[variant]} ${className}`}
      {...props}
    >
      {loading ? (
        <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
      ) : (
        Icon && <Icon aria-hidden="true" className="h-4 w-4" />
      )}
      {children}
    </button>
  );
}

/** A link that looks like a button: pass react-router's Link (or 'a') as `as`. */
export function ButtonLink({
  as: Component,
  variant = 'primary',
  size = 'md',
  icon: Icon,
  className = '',
  children,
  ...props
}) {
  return (
    <Component className={`${base} ${sizes[size]} ${variants[variant]} ${className}`} {...props}>
      {Icon && <Icon aria-hidden="true" className="h-4 w-4" />}
      {children}
    </Component>
  );
}
