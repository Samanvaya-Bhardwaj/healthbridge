import { Link, Outlet } from 'react-router';
import { Logo } from '../../components/ui/Logo.jsx';
import { SystemStatus } from '../../features/system/SystemStatus.jsx';
import { DemoBanner } from '../../features/system/DemoBanner.jsx';
import { useAuth } from '../../features/auth/authContext.js';

function HeaderActions() {
  const { status } = useAuth();
  if (status === 'loading') return null;
  if (status === 'authenticated') {
    return (
      <Link
        to="/app"
        className="rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-primary-contrast hover:bg-primary-hover"
      >
        Open HealthBridge
      </Link>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <Link
        to="/login"
        className="whitespace-nowrap rounded-full px-3 py-2.5 text-sm font-medium text-text-muted hover:text-text sm:px-4"
      >
        Sign in
      </Link>
      <Link
        to="/register"
        className="whitespace-nowrap rounded-full bg-primary px-4 py-2.5 text-sm font-medium text-primary-contrast hover:bg-primary-hover sm:px-5"
      >
        Create account
      </Link>
    </div>
  );
}

export function PublicLayout() {
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
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-2 px-4 sm:px-6">
          <Link to="/" aria-label="HealthBridge home">
            <Logo />
          </Link>
          <HeaderActions />
        </div>
      </header>
      <main id="main" className="flex-1">
        <Outlet />
      </main>
      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-6 py-6 text-sm text-text-subtle sm:flex-row sm:items-center sm:justify-between">
          <p>© {new Date().getFullYear()} HealthBridge</p>
          <SystemStatus />
        </div>
      </footer>
    </div>
  );
}
