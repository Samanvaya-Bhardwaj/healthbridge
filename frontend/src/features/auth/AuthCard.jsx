import { HeartPulse, ShieldCheck, Stethoscope } from 'lucide-react';
import { LogoMark } from '../../components/ui/Logo.jsx';

const reassurances = [
  [Stethoscope, 'Your own doctor, online first'],
  [ShieldCheck, 'Records shared only with your consent'],
  [HeartPulse, 'Consultations, prescriptions and reports in one place'],
];

/**
 * What HealthBridge is, beside the form on wide screens. It comes after the form in the
 * reading order (shown first by CSS), so the page starts with its heading.
 */
function AuthAside() {
  return (
    <div className="hidden flex-col justify-between rounded-[2rem] bg-hero p-10 lg:order-first lg:flex">
      <div>
        <LogoMark className="h-11 w-11" />
        <p className="mt-10 max-w-sm text-[2rem] font-medium leading-[1.1] tracking-[-0.025em] text-text">
          Care that stays connected, between every visit.
        </p>
      </div>
      <ul className="mt-10 space-y-3">
        {reassurances.map(([Icon, text]) => (
          <li
            key={text}
            className="flex items-center gap-3 rounded-2xl border border-border bg-surface-raised/80 px-4 py-3 text-sm text-text shadow-card"
          >
            <span
              aria-hidden="true"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary"
            >
              <Icon className="h-4 w-4" />
            </span>
            {text}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Sign-in, registration and account recovery: the form card, with the sky panel beside it. */
export function AuthCard({ title, subtitle, children, footer }) {
  return (
    <div className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-10 px-4 py-10 sm:px-6 sm:py-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="mx-auto w-full max-w-md self-center lg:py-6">
        <LogoMark className="mb-6 h-10 w-10 lg:hidden" />
        <h1 className="text-[1.875rem] font-medium leading-tight tracking-[-0.02em] text-text">
          {title}
        </h1>
        {subtitle && <p className="mt-2 text-text-muted">{subtitle}</p>}
        <div className="mt-8 rounded-card border border-border bg-surface-raised p-6 shadow-card sm:p-8">
          {children}
        </div>
        {footer && <p className="mt-6 text-center text-sm text-text-muted">{footer}</p>}
      </div>
      <AuthAside />
    </div>
  );
}
