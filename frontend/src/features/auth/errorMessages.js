import { ApiError } from '../../lib/apiClient.js';

// Plain-language replacements for generic server wording. Domain-specific messages
// ("This check-in is no longer open.") are already written for people and pass through.
const BY_CODE = {
  unauthenticated: 'Your session has ended. Please sign in again.',
  token_expired: 'Your session has ended. Please sign in again.',
  token_invalid: 'Your session has ended. Please sign in again.',
  session_invalid: 'Your session has ended. Please sign in again.',
  csrf_token_invalid: 'This page was open for a long time. Reload it and try again.',
  csrf_origin_rejected: 'This page was open for a long time. Reload it and try again.',
  forbidden: 'You can’t do this with your account.',
  consent_required:
    'These records haven’t been shared. Only the patient can give access, in Privacy & Access.',
  not_found:
    'We couldn’t find this. It may have been removed, or it isn’t shared with your account.',
  conflict: 'This changed in the meantime. Reload the page and try again.',
  bad_request: 'That didn’t work. Check the details and try again.',
  validation_failed: 'Some details need correcting. Check the highlighted fields.',
  malformed_json: 'That didn’t work. Reload the page and try again.',
  unsupported_encoding: 'That didn’t work. Reload the page and try again.',
  invalid_cursor: 'This list has changed. Reload the page to see the latest.',
  payload_too_large: 'That is too large to send. Try a shorter text or a smaller file.',
  file_too_large: 'The file is too large. Files can be at most 10 MB.',
  service_unavailable: 'HealthBridge is temporarily unavailable. Please try again shortly.',
};

/**
 * Maps API errors to calm, non-revealing, plain-language messages. Never shows status
 * codes, error codes or technical wording; unknown errors fall back to a generic message
 * by status.
 */
export function authErrorMessage(error) {
  if (!(error instanceof ApiError)) return 'Something went wrong. Please try again.';
  switch (error.code) {
    case 'invalid_credentials':
      return 'Invalid email or password.';
    case 'account_unavailable':
      return 'This account is unavailable. Please contact support.';
    case 'rate_limited': {
      const minutes = Math.max(1, Math.ceil((error.retryAfterSeconds ?? 60) / 60));
      return `Too many attempts. Please wait ${minutes} minute${minutes === 1 ? '' : 's'} and try again.`;
    }
    case 'network_error':
    case 'timeout':
    case 'payment_provider_unavailable':
      return error.detail;
    default:
      if (BY_CODE[error.code]) return BY_CODE[error.code];
      if (error.status >= 500 || error.status === 0) return BY_CODE.service_unavailable;
      if (error.status === 401) return BY_CODE.unauthenticated;
      if (error.status === 404) return BY_CODE.not_found;
      return error.detail ?? 'Something went wrong. Please try again.';
  }
}

/** Server field errors ("body.password") → react-hook-form field names ("password"). */
export function applyFieldErrors(error, setError) {
  if (!(error instanceof ApiError)) return false;
  let applied = false;
  for (const { path, message } of error.errors) {
    const field = path.replace(/^body\./, '');
    if (field && !field.includes('.')) {
      setError(field, { type: 'server', message });
      applied = true;
    }
  }
  return applied;
}

/** True when the server could not be reached (or failed), not when it said no. */
export function isConnectionProblem(error) {
  if (!(error instanceof ApiError)) return false;
  return (
    ['network_error', 'timeout'].includes(error.code) || error.status === 0 || error.status >= 500
  );
}

/** AI assistance is optional: an outage there must not sound like HealthBridge is down. */
export function aiErrorMessage(error) {
  if (isConnectionProblem(error)) {
    return 'The AI assistant isn’t available right now. The records themselves are unaffected; try again in a few minutes.';
  }
  return authErrorMessage(error);
}
