import { Link } from 'react-router';
import { Home, Lock } from 'lucide-react';
import { ButtonLink } from '../../components/ui/Button.jsx';

/** Unauthorized state: the user is signed in but their role does not allow this page. */
export function ForbiddenPage() {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <span
        aria-hidden="true"
        className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary-soft text-primary"
      >
        <Lock className="h-6 w-6" />
      </span>
      <p className="text-sm font-medium text-primary">Access restricted</p>
      <h1 className="mt-2 text-2xl font-semibold text-text">You don’t have access to this page</h1>
      <p className="mt-3 text-text-muted">
        Your account’s role doesn’t include this area. Medical records are only ever visible to the
        patient and the doctors they share them with. If you think this is a mistake, contact your
        clinic or HealthBridge support.
      </p>
      <ButtonLink as={Link} to="/app" className="mt-8" icon={Home}>
        Go to your home page
      </ButtonLink>
    </div>
  );
}
