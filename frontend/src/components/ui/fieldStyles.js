/** Shared look of text-like form controls (inputs, selects, textareas). */
export const controlClass = (error, { inline = false } = {}) =>
  (inline ? '' : 'mt-1.5 ') +
  'block w-full rounded-lg border bg-surface-raised px-3.5 py-2.5 text-text ' +
  'placeholder:text-text-subtle min-h-11 transition-colors ' +
  (error ? 'border-danger' : 'border-border hover:border-text-subtle/50');
