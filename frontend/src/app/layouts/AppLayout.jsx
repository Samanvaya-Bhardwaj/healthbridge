import { useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router';
import { ROLE_LABELS } from '@healthbridge/shared';
import { useAuth } from '../../features/auth/authContext.js';
import { DemoBanner } from '../../features/system/DemoBanner.jsx';
import { navigationFor, primaryRole } from '../navigation.js';

const linkClass = ({ isActive }) =>
  `flex min-h-11 items-center rounded-lg px-3 text-sm font-medium transition-colors ${
    isActive
      ? 'bg-primary-soft text-primary'
      : 'text-text-muted hover:bg-surface-muted hover:text-text'
  }`;

/** Authenticated application shell with role-aware navigation. */
export function AppLayout() {
  const { user, signOut } = useAuth();
  const [signingOut, setSigningOut] = useState(false);
  const items = navigationFor(user);
  const role = primaryRole(user.roles);

  // RequireAuth redirects to sign-in once the session state becomes anonymous.
  const handleSignOut = async () => {
    setSigningOut(true);
    await signOut();
  };

  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-surface-raised focus:px-4 focus:py-2"
      >
        Skip to content
      </a>
      <DemoBanner />
      <header className="border-b border-border">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-6">
          <Link
            to="/app"
            className="flex items-center gap-2.5 font-semibold tracking-tight text-text"
          >
            <img src="/favicon.svg" alt="" width="28" height="28" />
            HealthBridge
          </Link>
          <div className="flex items-center gap-4">
            <div className="hidden text-right sm:block">
              <p className="text-sm font-medium text-text">{user.fullName}</p>
              <p className="text-xs text-text-subtle">{ROLE_LABELS[role]}</p>
            </div>
            <button
              type="button"
              onClick={handleSignOut}
              disabled={signingOut}
              className="min-h-11 rounded-lg border border-border px-3 text-sm font-medium text-text-muted hover:bg-surface-muted hover:text-text"
            >
              {signingOut ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col md:flex-row">
        <nav
          aria-label="Main"
          className="border-b border-border px-4 py-3 md:w-60 md:shrink-0 md:border-b-0 md:border-r md:py-6"
        >
          <ul className="flex gap-1 overflow-x-auto md:flex-col">
            {items.map((item) => (
              <li key={item.key} className="shrink-0">
                <NavLink
                  to={item.path ? `/app/${item.path}` : '/app'}
                  end={!item.path}
                  className={linkClass}
                >
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <main id="main" className="flex-1 px-6 py-8 md:px-10">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
