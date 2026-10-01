import { isRouteErrorResponse, Link, useRouteError } from 'react-router';
import { ErrorFallback } from './ErrorBoundary.jsx';

/** Route-level error element: renders inside the router so navigation keeps working. */
export function RouteError() {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFound />;
  return <ErrorFallback onRetry={() => window.location.reload()} />;
}

export function NotFound() {
  return (
    <div className="mx-auto max-w-md px-6 py-24 text-center">
      <p className="text-sm font-medium text-primary">404</p>
      <h1 className="mt-2 text-2xl font-semibold text-text">Page not found</h1>
      <p className="mt-3 text-text-muted">The page you are looking for does not exist.</p>
      <Link to="/" className="mt-8 inline-block font-medium text-primary hover:text-primary-hover">
        Return home
      </Link>
    </div>
  );
}
