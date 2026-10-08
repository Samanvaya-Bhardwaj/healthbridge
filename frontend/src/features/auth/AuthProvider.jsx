import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { hasSessionCookie, setAccessToken, setRefreshHandler } from '../../lib/apiClient.js';
import { AuthContext } from './authContext.js';
import { userHasPermission } from '../../app/navigation.js';
import * as authApi from './authApi.js';

// Refresh the access token shortly before it expires.
const REFRESH_MARGIN_SECONDS = 60;

/**
 * Owns client-side session state. The server remains the authority: this only mirrors
 * what /auth/me returns, and every API call is authorised server-side.
 */
export function AuthProvider({ children }) {
  const queryClient = useQueryClient();
  // Without a session cookie there is nothing to restore: start anonymous immediately.
  const [state, setState] = useState(() => ({
    status: hasSessionCookie() ? 'loading' : 'anonymous',
    user: null,
    endedReason: null,
  }));
  const timer = useRef(null);

  const scheduleRefresh = useCallback(function schedule(expiresIn) {
    clearTimeout(timer.current);
    const delay = Math.max(5, expiresIn - REFRESH_MARGIN_SECONDS) * 1000;
    timer.current = setTimeout(() => {
      authApi.refreshSession().then(
        (session) => schedule(session.expiresIn),
        () => {}, // the next API call will surface the expired session
      );
    }, delay);
  }, []);

  const endSession = useCallback(
    (reason) => {
      clearTimeout(timer.current);
      setAccessToken(null);
      queryClient.clear();
      setState({ status: 'anonymous', user: null, endedReason: reason });
    },
    [queryClient],
  );

  const establish = useCallback(
    async (session) => {
      scheduleRefresh(session.expiresIn);
      const user = await authApi.fetchMe();
      setState({ status: 'authenticated', user, endedReason: null });
      return user;
    },
    [scheduleRefresh],
  );

  // Used by the API client after a 401: one refresh attempt, otherwise the session is over.
  useEffect(() => {
    setRefreshHandler(async () => {
      try {
        const session = await authApi.refreshSession();
        scheduleRefresh(session.expiresIn);
        return true;
      } catch {
        endSession('expired');
        return false;
      }
    });
    return () => setRefreshHandler(null);
  }, [endSession, scheduleRefresh]);

  // Session restoration on page load (refresh cookie → new access token → profile).
  useEffect(() => {
    let cancelled = false;
    if (!hasSessionCookie()) return undefined;
    authApi
      .refreshSession()
      .then((session) => !cancelled && establish(session))
      // A session existed but can no longer be restored: say so on the sign-in page.
      .catch(
        () => !cancelled && setState({ status: 'anonymous', user: null, endedReason: 'expired' }),
      );
    return () => {
      cancelled = true;
    };
  }, [establish]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const signIn = useCallback(
    async (credentials) => establish(await authApi.login(credentials)),
    [establish],
  );

  const signOut = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      endSession('signed_out');
    }
  }, [endSession]);

  const value = useMemo(
    () => ({
      ...state,
      signIn,
      signOut,
      hasPermission: (permission) =>
        Boolean(state.user && userHasPermission(state.user, permission)),
    }),
    [state, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
