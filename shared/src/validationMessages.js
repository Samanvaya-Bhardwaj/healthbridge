/**
 * Plain-language wording for validation rules that have no message of their own.
 * Zod's defaults ("Too small: expected string to have >=2 characters") reach people
 * through form errors and API field errors, so every generic rule gets a sentence a
 * patient can act on. Messages written on a schema always take precedence.
 *
 * @param {{ code: string, input?: unknown, origin?: string, minimum?: number | bigint, maximum?: number | bigint, format?: string }} issue
 * @returns {string}
 */
export function plainValidationMessage(issue) {
  const empty = issue.input === undefined || issue.input === null || issue.input === '';
  switch (issue.code) {
    case 'invalid_type':
      return empty ? 'This is required.' : 'Enter a valid value.';
    case 'too_small':
      if (issue.origin === 'string') {
        if (empty || Number(issue.minimum) <= 1) return 'This is required.';
        return `Use at least ${issue.minimum} characters.`;
      }
      if (issue.origin === 'array' || issue.origin === 'set') {
        return Number(issue.minimum) <= 1 ? 'Add at least one.' : `Add at least ${issue.minimum}.`;
      }
      return `Enter ${issue.minimum} or more.`;
    case 'too_big':
      if (issue.origin === 'string') return `Use at most ${issue.maximum} characters.`;
      if (issue.origin === 'array' || issue.origin === 'set') {
        return `You can add at most ${issue.maximum}.`;
      }
      return `Enter ${issue.maximum} or less.`;
    case 'invalid_format':
      if (issue.format === 'email') return 'Enter an email address like name@example.com.';
      if (issue.format === 'url') return 'Enter a web address starting with https://.';
      if (issue.format === 'date' || issue.format === 'datetime') return 'Enter a valid date.';
      if (issue.format === 'time') return 'Enter a valid time.';
      return 'This doesn’t look right. Check it and try again.';
    case 'invalid_value':
    case 'invalid_union':
      return 'Choose one of the options.';
    case 'not_multiple_of':
      return 'Enter a whole number.';
    case 'unrecognized_keys':
      return 'Something unexpected was sent. Reload the page and try again.';
    default:
      return 'Check this and try again.';
  }
}
