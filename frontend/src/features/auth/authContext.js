import { createContext, useContext } from 'react';

/**
 * @typedef {{ id: string, email: string, fullName: string, roles: string[], permissions: string[] }} AuthUser
 * @typedef {{
 *   status: 'loading' | 'authenticated' | 'anonymous',
 *   user: AuthUser | null,
 *   endedReason: 'expired' | 'signed_out' | null,
 *   signIn: (credentials: { email: string, password: string }) => Promise<AuthUser>,
 *   signOut: () => Promise<void>,
 *   hasPermission: (permission: string) => boolean,
 * }} AuthState
 */

export const AuthContext = createContext(/** @type {AuthState | null} */ (null));

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}
