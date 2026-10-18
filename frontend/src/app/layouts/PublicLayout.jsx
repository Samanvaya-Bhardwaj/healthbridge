import { useRef } from 'react';
import { Link, Outlet } from 'react-router';
import { Phone } from 'lucide-react';
import { useRouteFocus } from '../useRouteFocus.js';
import { Logo } from '../../components/ui/Logo.jsx';
import { ButtonLink } from '../../components/ui/Button.jsx';
import { SystemStatus } from '../../features/system/SystemStatus.jsx';
import { DemoBanner } from '../../features/system/DemoBanner.jsx';
import { useAuth } from '../../features/auth/authContext.js';

function HeaderActions() {
  const { status } = useAuth();
  if (status === 'loading') return null;
  if (status === 'authenticated') {
    return (
      <ButtonLink as={Link} to="/app" size="sm" arrow>
        Open HealthBridge
      </ButtonLink>
    );
  }
  return (
    <div className="flex items-center gap-1 sm:gap-2">
      <Link
        to="/login"
        className="whitespace-nowrap rounded-full px-3 py-2 text-sm font-medium text-text-muted transition-colors hover:bg-surface-muted hover:text-text sm:px-4"
      >
        Sign in
      </Link>
      <ButtonLink as={Link} to="/register" size="sm" className="whitespace-nowrap">
        Create account
      </ButtonLink>
    </div>
  );
}

// Named apart from the page's own links ("Sign in", "Forgot your password?").
const FOOTER_LINKS = [
  [
    'Your account',
    [
      ['/register', 'Create an account'],
      ['/login', 'Sign in to your account'],
      ['/forgot-password', 'Reset your password'],
    ],
  ],
];

/** The wordmark, large and faint, closing the page (decorative). */
function FooterWordmark() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 1000 180"
      className="mt-10 hidden w-full text-primary-soft md:block"
      preserveAspectRatio="xMinYMid meet"
    >
      <text
        x="0"
        y="135"
        fill="currentColor"
        style={{ fontSize: 168, fontWeight: 500, letterSpacing: '-0.04em' }}
      >
        HealthBridge
      </text>
    </svg>
  );
}

export function PublicLayout() {
  const mainRef = useRef(null);
  useRouteFocus(mainRef);
  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-full focus:bg-surface-raised focus:px-4 focus:py-2"
      >
        Skip to content
      </a>
      <DemoBanner />
      <header className="sticky top-0 z-40 px-3 pt-3 sm:px-6">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-2 rounded-full border border-border bg-surface-raised/85 pl-4 pr-2 shadow-card backdrop-blur-md supports-[not(backdrop-filter:blur(0))]:bg-surface-raised">
          <Link to="/" aria-label="HealthBridge home" className="rounded-full">
            <Logo />
          </Link>
          <HeaderActions />
        </div>
      </header>
      <main id="main" ref={mainRef} tabIndex={-1} className="flex-1 outline-none">
        <Outlet />
      </main>
      <footer className="mt-16 border-t border-border bg-surface-raised">
        <div className="mx-auto max-w-6xl px-6 pb-8 pt-12">
          <div className="grid grid-cols-1 gap-10 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)]">
            <div className="max-w-sm">
              <Logo />
              <p className="mt-4 text-sm leading-relaxed text-text-muted">
                Online-first care with the doctors who already know you. Your records stay yours,
                shared only with your consent.
              </p>
            </div>
            {FOOTER_LINKS.map(([heading, links]) => (
              <nav key={heading} aria-label={heading}>
                <p className="font-mono text-[0.6875rem] font-medium uppercase tracking-[0.1em] text-text-subtle">
                  {heading}
                </p>
                <ul className="mt-3 space-y-2 text-sm">
                  {links.map(([to, label]) => (
                    <li key={to}>
                      <Link to={to} className="text-text hover:text-primary">
                        {label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </nav>
            ))}
            <div>
              <p className="font-mono text-[0.6875rem] font-medium uppercase tracking-[0.1em] text-text-subtle">
                In an emergency
              </p>
              <p className="mt-3 text-sm text-text">
                Call{' '}
                <a href="tel:112" className="font-semibold text-danger underline">
                  112
                </a>{' '}
                or{' '}
                <a href="tel:108" className="font-semibold text-danger underline">
                  108
                </a>
                , or go to the nearest emergency department.
              </p>
              <p className="mt-2 flex items-center gap-1.5 text-xs text-text-subtle">
                <Phone aria-hidden="true" className="h-3.5 w-3.5" />
                Don’t wait for an online consultation.
              </p>
            </div>
          </div>
          <FooterWordmark />
          <div className="mt-8 flex flex-col gap-3 border-t border-border pt-6 text-sm text-text-subtle sm:flex-row sm:items-center sm:justify-between">
            <p>© {new Date().getFullYear()} HealthBridge</p>
            <SystemStatus />
          </div>
        </div>
      </footer>
    </div>
  );
}
