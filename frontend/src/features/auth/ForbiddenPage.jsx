import { Link } from 'react-router';

/** Unauthorized state: the user is signed in but their role does not allow this page. */
export function ForbiddenPage() {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <p className="text-sm font-medium text-primary">Access restricted</p>
      <h1 className="mt-2 text-2xl font-semibold text-text">You don’t have access to this page</h1>
      <p className="mt-3 text-text-muted">
        Your account’s role doesn’t include this area. If you think this is a mistake, contact your
        clinic or HealthBridge support.
      </p>
      <Link
        to="/app"
        className="mt-8 inline-block font-medium text-primary hover:text-primary-hover"
      >
        Go to your home page
      </Link>
    </div>
  );
}
