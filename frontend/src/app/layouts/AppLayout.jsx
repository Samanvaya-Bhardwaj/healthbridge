import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, NavLink, Outlet, useLocation } from 'react-router';
import { LogOut, Menu, X } from 'lucide-react';
import { ROLE_LABELS } from '@healthbridge/shared';
import { useAuth } from '../../features/auth/authContext.js';
import { DemoBanner } from '../../features/system/DemoBanner.jsx';
import { navigationFor, primaryRole } from '../navigation.js';
import { NotificationBell } from '../../features/notifications/Inbox.jsx';
import { Avatar } from '../../components/ui/Identity.jsx';

const linkClass = ({ isActive }) =>
  `flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors ${
    isActive
      ? 'bg-primary-soft text-primary'
      : 'text-text-muted hover:bg-surface-muted hover:text-text'
  }`;

/** Navigation grouped under the role's plain-language headings. */
function NavList({ items, onNavigate, idPrefix }) {
  const groups = [];
  for (const item of items) {
    const name = item.group ?? '';
    const group = groups.find((g) => g.name === name);
    if (group) group.items.push(item);
    else groups.push({ name, items: [item] });
  }
  return (
    <div className="space-y-6">
      {groups.map((group) => {
        const headingId = `${idPrefix}-${group.name.replace(/\W+/g, '-').toLowerCase() || 'main'}`;
        return (
          <div key={group.name}>
            {group.name && (
              <p
                id={headingId}
                className="px-3 pb-1.5 text-xs font-semibold uppercase tracking-wide text-text-subtle"
              >
                {group.name}
              </p>
            )}
            <ul className="space-y-0.5" aria-labelledby={group.name ? headingId : undefined}>
              {group.items.map((item) => {
                const Icon = item.icon;
                return (
                  <li key={item.key}>
                    <NavLink
                      to={item.path ? `/app/${item.path}` : '/app'}
                      end={!item.path}
                      className={linkClass}
                      onClick={onNavigate}
                    >
                      {Icon && <Icon aria-hidden="true" className="h-5 w-5 shrink-0" />}
                      {item.label}
                    </NavLink>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

/** Mobile menu: a modal sheet with focus trap, Escape to close and focus return. */
function MobileMenu({ open, onClose, items, user, role, onSignOut, signingOut }) {
  const panel = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const opener = document.activeElement;
    panel.current?.querySelector('a, button')?.focus();
    const root = document.getElementById('root');
    root?.setAttribute('inert', '');
    return () => {
      root?.removeAttribute('inert');
      opener?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  const onKeyDown = (event) => {
    if (event.key === 'Escape') return onClose();
    if (event.key !== 'Tab') return undefined;
    const focusables = [...panel.current.querySelectorAll('a, button')];
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
    return undefined;
  };
  return createPortal(
    <div className="fixed inset-0 z-50 md:hidden">
      <div className="absolute inset-0 bg-black/40" aria-hidden="true" onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Menu"
        onKeyDown={onKeyDown}
        className="absolute inset-y-0 left-0 flex w-80 max-w-[85vw] flex-col overflow-y-auto bg-surface-raised px-4 py-4 shadow-overlay"
      >
        <div className="mb-4 flex items-center justify-between">
          <span className="flex items-center gap-3">
            <Avatar name={user.fullName} size="sm" />
            <span>
              <span className="block text-sm font-medium text-text">{user.fullName}</span>
              <span className="block text-xs text-text-subtle">{ROLE_LABELS[role]}</span>
            </span>
          </span>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-text-muted hover:bg-surface-muted"
            aria-label="Close menu"
          >
            <X aria-hidden="true" className="h-5 w-5" />
          </button>
        </div>
        <nav aria-label="Main">
          <NavList items={items} onNavigate={onClose} idPrefix="mobile-nav" />
        </nav>
        <button
          type="button"
          onClick={onSignOut}
          disabled={signingOut}
          className="mt-6 flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium text-text-muted hover:bg-surface-muted hover:text-text"
        >
          <LogOut aria-hidden="true" className="h-5 w-5" />
          {signingOut ? 'Signing out…' : 'Sign out'}
        </button>
      </div>
    </div>,
    document.body,
  );
}

/** Authenticated application shell with role-aware navigation. */
export function AppLayout() {
  const { user, signOut } = useAuth();
  const [signingOut, setSigningOut] = useState(false);
  const location = useLocation();
  // The menu remembers the page it was opened on, so any navigation closes it.
  const [menuPath, setMenuPath] = useState(null);
  const menuOpen = menuPath === location.pathname;
  const setMenuOpen = (open) => setMenuPath(open ? location.pathname : null);
  const items = navigationFor(user);
  const role = primaryRole(user.roles);

  // RequireAuth redirects to sign-in once the session state becomes anonymous.
  const handleSignOut = async () => {
    setSigningOut(true);
    await signOut();
  };

  return (
    <div className="flex min-h-dvh flex-col bg-surface-muted/40">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-surface-raised focus:px-4 focus:py-2"
      >
        Skip to content
      </a>
      <DemoBanner />
      <header className="border-b border-border bg-surface-raised">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-3 px-4 sm:px-6">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setMenuOpen(true)}
              className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-text-muted hover:bg-surface-muted md:hidden"
              aria-label="Open menu"
              aria-expanded={menuOpen}
            >
              <Menu aria-hidden="true" className="h-5 w-5" />
            </button>
            <Link
              to="/app"
              className="flex items-center gap-2.5 font-semibold tracking-tight text-text"
            >
              <img src="/favicon.svg" alt="" width="28" height="28" />
              HealthBridge
            </Link>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <NotificationBell />
            <div className="hidden items-center gap-3 sm:flex">
              <Avatar name={user.fullName} size="sm" />
              <div className="text-right">
                <p className="text-sm font-medium text-text">{user.fullName}</p>
                <p className="text-xs text-text-subtle">{ROLE_LABELS[role]}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={handleSignOut}
              disabled={signingOut}
              className="hidden min-h-11 items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium text-text-muted hover:bg-surface-muted hover:text-text md:inline-flex"
            >
              <LogOut aria-hidden="true" className="h-4 w-4" />
              {signingOut ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        </div>
      </header>

      <MobileMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        items={items}
        user={user}
        role={role}
        onSignOut={handleSignOut}
        signingOut={signingOut}
      />

      <div className="mx-auto flex w-full max-w-7xl flex-1">
        <nav
          aria-label="Main"
          className="hidden w-64 shrink-0 border-r border-border px-3 py-6 md:block"
        >
          <NavList items={items} idPrefix="nav" />
        </nav>
        <main id="main" className="min-w-0 flex-1 px-4 py-6 sm:px-6 md:px-10 md:py-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
