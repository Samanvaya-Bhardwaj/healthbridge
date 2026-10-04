import { forwardRef, useId } from 'react';
import { Upload } from 'lucide-react';
import { ErrorText, HelperText } from './Typography.jsx';
import { controlClass } from './fieldStyles.js';

/**
 * Form controls (design system). Every control has a visible label, optional hint, and
 * an error wired with aria-invalid / aria-describedby. All forward refs, so they work
 * with react-hook-form `{...register('name')}` as well as controlled usage.
 *
 *   TextField (text, email, password, date, time, number, search…), SelectField,
 *   TextAreaField, CheckboxField, RadioGroup, FileField
 *
 * Height 2.75rem (min-h-11) for tap targets; radius lg; border turns red on error.
 */
function useFieldIds(hint, error) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return {
    id,
    hintId,
    errorId,
    describedBy: [hintId, errorId].filter(Boolean).join(' ') || undefined,
  };
}

function FieldShell({ id, label, hint, hintId, error, errorId, className, children, optional }) {
  return (
    <div className={className}>
      <label htmlFor={id} className="block text-sm font-medium text-text">
        {label}
        {optional && <span className="font-normal text-text-subtle"> (optional)</span>}
      </label>
      {hint && (
        <HelperText id={hintId} className="mt-1">
          {hint}
        </HelperText>
      )}
      {children}
      {error && (
        <ErrorText id={errorId} className="mt-1.5">
          {error}
        </ErrorText>
      )}
    </div>
  );
}

export const TextField = forwardRef(function TextField(
  { label, error, hint, optional, type = 'text', className = '', ...props },
  ref,
) {
  const ids = useFieldIds(hint, error);
  return (
    <FieldShell
      {...ids}
      label={label}
      hint={hint}
      error={error}
      optional={optional}
      className={className}
    >
      <input
        ref={ref}
        id={ids.id}
        type={type}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={ids.describedBy}
        className={controlClass(error)}
        {...props}
      />
    </FieldShell>
  );
});

export const SelectField = forwardRef(function SelectField(
  { label, error, hint, optional, options, placeholder, className = '', ...props },
  ref,
) {
  const ids = useFieldIds(hint, error);
  return (
    <FieldShell
      {...ids}
      label={label}
      hint={hint}
      error={error}
      optional={optional}
      className={className}
    >
      <select
        ref={ref}
        id={ids.id}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={ids.describedBy}
        className={`${controlClass(error)} pr-8`}
        {...props}
      >
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
});

export const TextAreaField = forwardRef(function TextAreaField(
  { label, error, hint, optional, rows = 4, className = '', ...props },
  ref,
) {
  const ids = useFieldIds(hint, error);
  return (
    <FieldShell
      {...ids}
      label={label}
      hint={hint}
      error={error}
      optional={optional}
      className={className}
    >
      <textarea
        ref={ref}
        id={ids.id}
        rows={rows}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={ids.describedBy}
        className={`${controlClass(error)} leading-relaxed`}
        {...props}
      />
    </FieldShell>
  );
});

export const CheckboxField = forwardRef(function CheckboxField(
  { label, description, error, className = '', ...props },
  ref,
) {
  const ids = useFieldIds(description, error);
  return (
    <div className={className}>
      <label htmlFor={ids.id} className="flex items-start gap-3 text-sm text-text">
        <input
          ref={ref}
          id={ids.id}
          type="checkbox"
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={ids.describedBy}
          className="mt-0.5 h-5 w-5 shrink-0 rounded border-border accent-primary"
          {...props}
        />
        <span>
          <span className="font-medium">{label}</span>
          {description && (
            <span id={ids.hintId} className="mt-0.5 block text-text-muted">
              {description}
            </span>
          )}
        </span>
      </label>
      {error && (
        <ErrorText id={ids.errorId} className="mt-1.5">
          {error}
        </ErrorText>
      )}
    </div>
  );
});

/** Radio group with a fieldset/legend. `options`: [{ value, label, description? }]. */
export function RadioGroup({
  legend,
  name,
  options,
  value,
  onChange,
  error,
  hint,
  inline = false,
  className = '',
}) {
  const ids = useFieldIds(hint, error);
  return (
    <fieldset className={`min-w-0 ${className}`} aria-describedby={ids.describedBy}>
      <legend className="text-sm font-medium text-text">{legend}</legend>
      {hint && (
        <HelperText id={ids.hintId} className="mt-1">
          {hint}
        </HelperText>
      )}
      <div className={inline ? 'mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4' : 'mt-2 space-y-2'}>
        {options.map((o) => (
          <label
            key={o.value}
            className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3.5 py-3 text-sm ${
              value === o.value ? 'border-primary bg-primary-soft' : 'border-border'
            }`}
          >
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
              className="mt-0.5 h-4 w-4 accent-primary"
            />
            <span>
              <span className="font-medium text-text">{o.label}</span>
              {o.description && <span className="block text-text-muted">{o.description}</span>}
            </span>
          </label>
        ))}
      </div>
      {error && (
        <ErrorText id={ids.errorId} className="mt-1.5">
          {error}
        </ErrorText>
      )}
    </fieldset>
  );
}

/** File picker with a large, labelled drop-style target (keyboard: Tab + Space/Enter). */
export const FileField = forwardRef(function FileField(
  { label, hint, error, fileName, className = '', ...props },
  ref,
) {
  const ids = useFieldIds(hint, error);
  return (
    <FieldShell {...ids} label={label} hint={hint} error={error} className={className}>
      <div
        className={`relative mt-1.5 flex items-center gap-3 rounded-lg border border-dashed px-4 py-4 focus-within:outline-2 focus-within:outline-focus ${
          error ? 'border-danger' : 'border-border'
        }`}
      >
        <Upload aria-hidden="true" className="h-5 w-5 shrink-0 text-primary" />
        <span className="text-sm text-text-muted">
          {fileName ? <span className="font-medium text-text">{fileName}</span> : 'Choose a file'}
        </span>
        <input
          ref={ref}
          id={ids.id}
          type="file"
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={ids.describedBy}
          className="absolute inset-0 cursor-pointer opacity-0"
          {...props}
        />
      </div>
    </FieldShell>
  );
});
