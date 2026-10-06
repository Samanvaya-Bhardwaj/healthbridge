/**
 * The HealthBridge mark: two points (patient and doctor) joined by a bridge arc, with a
 * small medical cross between them. The wordmark puts "Bridge" in the care colour.
 */
export function LogoMark({ className = 'h-8 w-8' }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={className}>
      <rect width="32" height="32" rx="9" className="fill-primary" />
      <g fill="none" stroke="currentColor" strokeLinecap="round" className="text-primary-contrast">
        <path d="M5.5 21.5C9 13.5 23 13.5 26.5 21.5" strokeWidth="2.4" />
        <path d="M16 18v4.6M13.7 20.3h4.6" strokeWidth="1.9" />
      </g>
      <circle cx="5.5" cy="22" r="2.1" className="fill-primary-contrast" />
      <circle cx="26.5" cy="22" r="2.1" className="fill-primary-contrast" />
    </svg>
  );
}

export function Logo({ className = '' }) {
  return (
    <span className={`flex items-center gap-2.5 ${className}`}>
      <LogoMark />
      <span className="text-[1.0625rem] font-semibold tracking-tight text-text">
        Health<span className="text-primary">Bridge</span>
      </span>
    </span>
  );
}
