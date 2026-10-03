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
      className="relative flex gap-1 overflow-x-auto border-b border-border"
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
            className={`-mb-px inline-flex min-h-11 shrink-0 items-center gap-2 border-b-2 px-4 text-sm font-medium transition-colors ${
              selected
                ? 'border-primary text-primary'
                : 'border-transparent text-text-muted hover:text-text'
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
