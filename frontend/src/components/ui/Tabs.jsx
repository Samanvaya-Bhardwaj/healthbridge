import { useRef } from 'react';

/**
 * Accessible tabs (WAI-ARIA tabs pattern): one tab stop, Left/Right/Home/End move between
 * tabs, and the selected tab is the only one in the Tab order.
 * `tabs`: [[key, label, Icon?], …]. The panel is rendered by the caller.
 */
export function Tabs({ tabs, value, onChange, label }) {
  const refs = useRef([]);
  const move = (index) => {
    const next = (index + tabs.length) % tabs.length;
    onChange(tabs[next][0]);
    refs.current[next]?.focus();
  };
  const onKeyDown = (event, index) => {
    if (event.key === 'ArrowRight') move(index + 1);
    else if (event.key === 'ArrowLeft') move(index - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(tabs.length - 1);
    else return;
    event.preventDefault();
  };
  return (
    <div
      role="tablist"
      aria-label={label}
      className="relative inline-flex max-w-full gap-1 overflow-x-auto rounded-full border border-border bg-surface-muted p-1"
    >
      {tabs.map(([key, text, Icon], index) => {
        const selected = value === key;
        return (
          <button
            key={key}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(key)}
            onKeyDown={(e) => onKeyDown(e, index)}
            className={`inline-flex min-h-10 shrink-0 items-center gap-2 rounded-full px-4 text-sm font-medium transition-[background-color,color,box-shadow] ${
              selected
                ? 'bg-surface-raised text-primary shadow-card ring-1 ring-border'
                : 'text-text-muted hover:bg-surface-raised/60 hover:text-text'
            }`}
          >
            {Icon && <Icon aria-hidden="true" className="h-4 w-4" />}
            {text}
          </button>
        );
      })}
    </div>
  );
}
