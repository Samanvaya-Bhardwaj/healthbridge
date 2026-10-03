import { useEffect } from 'react';
import { isRouteErrorResponse, Link, useRouteError } from 'react-router';
import { Compass, Home } from 'lucide-react';
import { ErrorFallback } from './ErrorBoundary.jsx';
import { ButtonLink } from '../components/ui/Button.jsx';
import { reportClientError } from '../lib/errorReporting.js';

/** Route-level error element: renders inside the router so navigation keeps working. */
export function RouteError() {
  const error = useRouteError();
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  useEffect(() => {
    if (!notFound) reportClientError('render_error', error);
  }, [error, notFound]);
  if (notFound) return <NotFound />;
  return <ErrorFallback onRetry={() => window.location.reload()} />;
}

export function NotFound() {
  return (
    <div className="mx-auto max-w-md px-6 py-24 text-center">
      <span
        aria-hidden="true"
        className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary-soft text-primary"
      >
        <Compass className="h-6 w-6" />
      </span>
      <p className="text-sm font-medium text-primary">404</p>
      <h1 className="mt-2 text-2xl font-semibold text-text">Page not found</h1>
      <p className="mt-3 text-text-muted">
        The page you are looking for does not exist or has moved. Use the menu, or start again from
        the home page.
      </p>
      <ButtonLink as={Link} to="/" className="mt-8" icon={Home}>
        Return home
      </ButtonLink>
    </div>
  );
}
