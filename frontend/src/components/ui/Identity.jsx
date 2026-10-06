import { BadgeCheck } from 'lucide-react';

const initials = (name = '') =>
  name
    .replace(/^(dr\.?|mr\.?|mrs\.?|ms\.?)\s+/i, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');

const sizes = { sm: 'h-8 w-8 text-xs', md: 'h-10 w-10 text-sm', lg: 'h-14 w-14 text-base' };

/** Initials avatar (no photos are stored). Decorative: the name is always shown beside it. */
export function Avatar({ name, size = 'md', tone = 'primary' }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold ${sizes[size]} ${
        tone === 'primary' ? 'bg-primary-soft text-primary' : 'bg-surface-muted text-text-muted'
      }`}
    >
      {initials(name) || '?'}
    </span>
  );
}

/**
 * A person in a list or header: avatar, name, an optional "Verified doctor" mark, and a
 * secondary line (specialisation, relationship, email …).
 */
export function PersonIdentity({ name, detail, verified = false, size = 'md', tone }) {
  return (
    <span className="flex min-w-0 items-center gap-3">
      <Avatar name={name} size={size} tone={tone} />
      <span className="min-w-0">
        <span className="flex items-center gap-1 font-medium text-text">
          <span className="[overflow-wrap:anywhere]">{name}</span>
          {verified && (
            <BadgeCheck
              className="h-4 w-4 shrink-0 text-primary"
              aria-label="Verified doctor"
              role="img"
            />
          )}
        </span>
        {detail && <span className="block truncate text-sm text-text-subtle">{detail}</span>}
      </span>
    </span>
  );
}
