import { forwardRef, useId } from 'react';

/** Labelled native select (accessible by default) for react-hook-form `register`. */
export const SelectField = forwardRef(function SelectField(
  { label, error, options, placeholder, className = '', ...props },
  ref,
) {
  const id = useId();
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className={className}>
      <label htmlFor={id} className="block text-sm font-medium text-text">
        {label}
      </label>
      <select
        ref={ref}
        id={id}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={errorId}
        className={`mt-1.5 block min-h-11 w-full rounded-lg border bg-surface-raised px-3 py-2.5 text-text ${
          error ? 'border-danger' : 'border-border'
        }`}
        {...props}
      >
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {error && (
        <p id={errorId} className="mt-1.5 text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
});
