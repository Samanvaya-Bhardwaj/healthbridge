import { Link, Outlet } from 'react-router';
import { SystemStatus } from '../../features/system/SystemStatus.jsx';
import { DemoBanner } from '../../features/system/DemoBanner.jsx';

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
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <Link to="/" className="flex items-center gap-2.5 font-semibold tracking-tight text-text">
            <img src="/favicon.svg" alt="" width="28" height="28" />
            HealthBridge
          </Link>
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
