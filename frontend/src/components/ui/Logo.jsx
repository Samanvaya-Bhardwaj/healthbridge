import { useId } from 'react';

/**
 * The HealthBridge mark: two points (patient and doctor) joined by a bridge arc, with a
 * small medical cross between them, on a sky gradient tile. The wordmark puts "Bridge" in
 * the care colour.
 */
export function LogoMark({ className = 'h-8 w-8' }) {
  // Each mark gets its own gradient id: several marks can share a page.
  const gradient = `hb-mark-${useId().replace(/:/g, '')}`;
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#38bdf8" />
          <stop offset="1" stopColor="#0369a1" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="10" fill={`url(#${gradient})`} />
      <g fill="none" stroke="#ffffff" strokeLinecap="round">
        <path d="M5.5 21.5C9 13.5 23 13.5 26.5 21.5" strokeWidth="2.4" />
        <path d="M16 18v4.6M13.7 20.3h4.6" strokeWidth="1.9" />
      </g>
      <circle cx="5.5" cy="22" r="2.1" fill="#ffffff" />
      <circle cx="26.5" cy="22" r="2.1" fill="#ffffff" />
    </svg>
  );
}

export function Logo({ className = '' }) {
  return (
    <span className={`flex items-center gap-2.5 ${className}`}>
      <LogoMark />
      <span className="text-[1.0625rem] font-semibold tracking-[-0.02em] text-text">
        Health<span className="text-primary">Bridge</span>
      </span>
    </span>
  );
}
