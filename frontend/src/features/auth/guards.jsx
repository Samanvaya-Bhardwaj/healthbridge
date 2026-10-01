import { Navigate, Outlet, useLocation } from 'react-router';
import { useAuth } from './authContext.js';
import { FullPageSpinner } from '../../components/ui/Spinner.jsx';
import { ForbiddenPage } from './ForbiddenPage.jsx';

/**
 * Client-side route guards improve UX only. Every API call is authorised by the
 * server; hiding a page here is never the security boundary.
 */
export function RequireAuth() {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <FullPageSpinner label="Restoring your session" />;
  if (status === 'anonymous') return <Navigate to="/login" replace state={{ from: location }} />;
  return <Outlet />;
}

export function RequirePermission({ permission, children }) {
  const { hasPermission } = useAuth();
  return hasPermission(permission) ? children : <ForbiddenPage />;
}
