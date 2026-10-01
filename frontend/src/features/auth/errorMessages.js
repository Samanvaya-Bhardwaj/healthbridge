import { ApiError } from '../../lib/apiClient.js';

/** Maps API errors to calm, non-revealing user-facing messages. */
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
      return error.detail;
    default:
      return error.status >= 500
        ? 'HealthBridge is temporarily unavailable. Please try again shortly.'
        : (error.detail ?? 'Something went wrong. Please try again.');
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
