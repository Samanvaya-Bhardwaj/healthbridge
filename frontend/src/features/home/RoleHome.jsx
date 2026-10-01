import { Link } from 'react-router';
import { ROLE_LABELS } from '@healthbridge/shared';
import { useAuth } from '../auth/authContext.js';
import { navigationFor, primaryRole } from '../../app/navigation.js';
import { Card } from '../../components/ui/Card.jsx';

/** Signed-in landing page: a calm overview of what this role can do. */
export function RoleHome() {
  const { user } = useAuth();
  const sections = navigationFor(user).filter((item) => item.description);
  const firstName = user.fullName.split(' ')[0];

  return (
    <div>
      <p className="text-sm font-medium text-primary">{ROLE_LABELS[primaryRole(user.roles)]}</p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight text-text">Welcome, {firstName}</h1>
      <p className="mt-2 max-w-2xl text-text-muted">
        Your workspace is ready. Clinical features arrive in upcoming releases; your account and
        sessions are fully managed today.
      </p>
      <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {sections.map((item) => (
          <li key={item.key}>
            <Link
              to={`/app/${item.path}`}
              className="block h-full rounded-2xl focus-visible:outline-offset-4"
            >
              <Card as="article" className="h-full hover:border-primary/40">
                <h2 className="text-base font-semibold text-text">{item.label}</h2>
                <p className="mt-2 text-sm leading-relaxed text-text-muted">{item.description}</p>
              </Card>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
