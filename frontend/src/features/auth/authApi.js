import { ApiError, apiRequest, setAccessToken } from '../../lib/apiClient.js';

const REFRESH_LOCK = 'healthbridge-session-refresh';
let inflight = null;

/** Serialises refreshes across tabs (Web Locks) so rotations never race each other. */
function withCrossTabLock(fn) {
  return globalThis.navigator?.locks?.request ? navigator.locks.request(REFRESH_LOCK, fn) : fn();
}

async function refreshOnce() {
  try {
    return await apiRequest('/auth/refresh', { method: 'POST' });
  } catch (err) {
    // Another tab rotated the token a moment ago; the cookie is already updated.
    if (err instanceof ApiError && err.code === 'refresh_conflict') {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return apiRequest('/auth/refresh', { method: 'POST' });
    }
    throw err;
  }
}

/** Single-flight session refresh. Resolves with the new session payload. */
export function refreshSession() {
  inflight ??= withCrossTabLock(refreshOnce)
    .then((payload) => {
      setAccessToken(payload.data.accessToken);
      return payload.data;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export async function login(credentials) {
  const payload = await apiRequest('/auth/login', { method: 'POST', body: credentials });
  setAccessToken(payload.data.accessToken);
  return payload.data;
}

export const register = (input) => apiRequest('/auth/register', { method: 'POST', body: input });

export async function logout() {
  try {
    await apiRequest('/auth/logout', { method: 'POST' });
  } finally {
    setAccessToken(null);
  }
}

export const fetchMe = async () => (await apiRequest('/auth/me')).data;
export const fetchSessions = async () => (await apiRequest('/auth/sessions')).data;
export const revokeSession = (id) =>
  apiRequest(`/auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const revokeOtherSessions = () =>
  apiRequest('/auth/sessions/revoke-others', { method: 'POST' });
export const changePassword = (input) =>
  apiRequest('/users/me/password', { method: 'POST', body: input });

// Account recovery (M11): the emailed token is read from the URL fragment, never a query.
export const requestPasswordReset = (email) =>
  apiRequest('/auth/password/forgot', { method: 'POST', body: { email } });
export const resetPassword = (input) =>
  apiRequest('/auth/password/reset', { method: 'POST', body: input });
export const verifyEmail = (token) =>
  apiRequest('/auth/email/verify', { method: 'POST', body: { token } });
export const resendEmailVerification = async () =>
  (await apiRequest('/users/me/email-verification', { method: 'POST' })).data;
export const fetchAccount = async () => (await apiRequest('/users/me')).data;
