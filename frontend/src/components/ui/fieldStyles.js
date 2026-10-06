/** Shared look of text-like form controls (inputs, selects, textareas). */
export const controlClass = (error, { inline = false } = {}) =>
  (inline ? '' : 'mt-1.5 ') +
  'block w-full rounded-xl border bg-surface-raised px-3.5 py-2.5 text-text ' +
  'placeholder:text-text-subtle min-h-11 transition-[border-color,box-shadow] ' +
  'focus:border-primary focus:shadow-[0_0_0_4px_var(--hb-primary-soft)] ' +
  (error ? 'border-danger' : 'border-border hover:border-text-subtle/50');
