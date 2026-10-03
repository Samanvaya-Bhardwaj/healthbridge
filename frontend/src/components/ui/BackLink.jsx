import { Link } from 'react-router';
import { ArrowLeft } from 'lucide-react';

/** "Back to …" link above a detail page, so users always know how to return. */
export function BackLink({ to, children }) {
  return (
    <Link
      to={to}
      className="inline-flex min-h-9 items-center gap-1 text-sm font-medium text-primary hover:text-primary-hover"
    >
      <ArrowLeft aria-hidden="true" className="h-4 w-4" />
      {children}
    </Link>
  );
}
