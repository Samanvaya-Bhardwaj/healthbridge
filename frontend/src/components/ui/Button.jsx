import { ArrowRight, Loader2 } from 'lucide-react';

const base =
  'group/button inline-flex items-center justify-center gap-2 rounded-full font-medium ' +
  'transition-[background-color,border-color,color,box-shadow,transform] duration-150 ' +
  'active:translate-y-px disabled:cursor-not-allowed disabled:opacity-60 disabled:active:translate-y-0';

const sizes = {
  md: 'min-h-11 px-5 py-2.5 text-sm',
  sm: 'min-h-9 px-3.5 py-1.5 text-sm',
};
// With a trailing arrow tile, the right padding shrinks so the tile sits in the pill.
const arrowSizes = { md: 'pr-1.5', sm: 'pr-1' };

const variants = {
  primary: 'bg-primary text-primary-contrast shadow-card hover:bg-primary-hover',
  secondary:
    'border border-border-strong bg-surface-raised text-text hover:border-primary/50 hover:bg-primary-soft/60',
  ghost: 'text-text-muted hover:bg-surface-muted hover:text-text',
  danger: 'bg-danger text-white hover:opacity-90',
  // AI assistance: its own quiet colour, so it reads as a helper, not the main action.
  ai: 'border border-ai/25 bg-ai-soft text-ai hover:border-ai/50',
};
// Design-system names; the original names stay valid.
variants.destructive = variants.danger;
variants.subtle = variants.ghost;

const tileVariants = {
  primary: 'bg-primary-contrast/15 text-primary-contrast',
  secondary: 'bg-primary text-primary-contrast',
  ghost: 'bg-primary-soft text-primary',
  danger: 'bg-white/15 text-white',
  ai: 'bg-ai text-ai-soft',
};
tileVariants.destructive = tileVariants.danger;
tileVariants.subtle = tileVariants.ghost;

/** The arrow tile at the end of a call to action ("Book a consult →"). */
function ArrowTile({ variant, size }) {
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center rounded-full transition-transform duration-150 group-hover/button:translate-x-0.5 ${
        size === 'sm' ? 'h-7 w-7' : 'h-8 w-8'
      } ${tileVariants[variant] ?? tileVariants.primary}`}
    >
      <ArrowRight className="h-4 w-4" />
    </span>
  );
}

/**
 * Buttons: primary (the one main action of an area), secondary, subtle/ghost and
 * destructive/danger. `icon` is a lucide component shown before the label. `arrow` adds
 * the arrow tile used for calls to action that move the person on. `loading` disables the
 * button and shows a spinner in place of the icon, keeping the label so the button does
 * not change size.
 * @param {{ variant?: keyof typeof variants, size?: 'md' | 'sm', icon?: import('react').ComponentType<any>, arrow?: boolean, loading?: boolean, type?: 'button' | 'submit' | 'reset' } & import('react').ButtonHTMLAttributes<HTMLButtonElement>} props
 */
export function Button({
  variant = 'primary',
  size = 'md',
  icon: Icon,
  arrow = false,
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
      className={`${base} ${sizes[size]} ${arrow ? arrowSizes[size] : ''} ${variants[variant]} ${className}`}
      {...props}
    >
      {loading ? (
        <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
      ) : (
        Icon && <Icon aria-hidden="true" className="h-4 w-4" />
      )}
      {children}
      {arrow && <ArrowTile variant={variant} size={size} />}
    </button>
  );
}

/** A link that looks like a button: pass react-router's Link (or 'a') as `as`. */
export function ButtonLink({
  as: Component,
  variant = 'primary',
  size = 'md',
  icon: Icon,
  arrow = false,
  className = '',
  children,
  ...props
}) {
  return (
    <Component
      className={`${base} ${sizes[size]} ${arrow ? arrowSizes[size] : ''} ${variants[variant]} ${className}`}
      {...props}
    >
      {Icon && <Icon aria-hidden="true" className="h-4 w-4" />}
      {children}
      {arrow && <ArrowTile variant={variant} size={size} />}
    </Component>
  );
}
