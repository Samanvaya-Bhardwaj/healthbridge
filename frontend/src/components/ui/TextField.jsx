import { forwardRef, useId } from 'react';

/**
 * Labelled input with accessible error and hint wiring.
 * Works with react-hook-form via `{...register('name')}` (ref is forwarded).
 */
export const TextField = forwardRef(function TextField(
  { label, error, hint, type = 'text', className = '', ...props },
  ref,
) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className={className}>
      <label htmlFor={id} className="block text-sm font-medium text-text">
        {label}
      </label>
      {hint && (
        <p id={hintId} className="mt-1 text-sm text-text-subtle">
          {hint}
        </p>
      )}
      <input
        ref={ref}
        id={id}
        type={type}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={[hintId, errorId].filter(Boolean).join(' ') || undefined}
        className={`mt-1.5 block w-full rounded-lg border bg-surface-raised px-3.5 py-2.5 text-text placeholder:text-text-subtle min-h-11 ${
          error ? 'border-danger' : 'border-border'
        }`}
        {...props}
      />
      {error && (
        <p id={errorId} className="mt-1.5 text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
});
