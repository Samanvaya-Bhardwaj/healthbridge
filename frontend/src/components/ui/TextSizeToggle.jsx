import { useState } from 'react';
import { ALargeSmall } from 'lucide-react';
import { applyTextSize, savedTextSize } from '../../lib/textSize.js';

/** One switch for larger text, in the header of every page a patient sees. */
export function TextSizeToggle() {
  const [size, setSize] = useState(savedTextSize);
  const large = size === 'large';
  const toggle = () => {
    const next = large ? 'normal' : 'large';
    applyTextSize(next);
    setSize(next);
  };
  return (
    <button
      type="button"
      data-tour="text-size"
      aria-pressed={large}
      aria-label="Larger text"
      onClick={toggle}
      className={`inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-full border px-3 text-sm font-medium transition-colors ${
        large
          ? 'border-primary bg-primary-soft text-primary'
          : 'border-border-strong text-text-muted hover:border-primary/50 hover:bg-primary-soft/60 hover:text-text'
      }`}
    >
      <ALargeSmall aria-hidden="true" className="h-5 w-5" />
      <span className="hidden lg:inline">Larger text</span>
    </button>
  );
}
