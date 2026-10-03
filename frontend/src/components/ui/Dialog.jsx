import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle } from 'lucide-react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal dialog: role="dialog" + aria-modal, labelled by its title, focus moved inside on
 * open and trapped there (Tab / Shift+Tab), Escape closes, and focus returns to the
 * element that opened it. The page behind is marked inert while open.
 */
export function Dialog({ open, title, description, onClose, children, footer, tone }) {
  const titleId = useId();
  const descId = useId();
  const panel = useRef(null);
  const opener = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    opener.current = document.activeElement;
    const root = document.getElementById('root');
    root?.setAttribute('inert', '');
    const first =
      panel.current?.querySelector('[data-autofocus]') ?? panel.current?.querySelector(FOCUSABLE);
    first?.focus();
    return () => {
      root?.removeAttribute('inert');
      opener.current?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = [...panel.current.querySelectorAll(FOCUSABLE)];
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  // Rendered outside #root (document.body) so the inert page does not include it.
  return (
    <DialogPortal>
      <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center">
        <div
          ref={panel}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={description ? descId : undefined}
          onKeyDown={onKeyDown}
          className="w-full max-w-md rounded-2xl border border-border bg-surface-raised p-6 shadow-overlay"
        >
          <div className="flex gap-3">
            {tone === 'warning' && (
              <AlertTriangle aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
            )}
            <div className="min-w-0">
              <h2 id={titleId} className="text-lg font-semibold text-text">
                {title}
              </h2>
              {description && (
                <p id={descId} className="mt-2 text-sm text-text-muted">
                  {description}
                </p>
              )}
            </div>
          </div>
          {children && <div className="mt-4">{children}</div>}
          {footer && <div className="mt-6 flex flex-wrap justify-end gap-2">{footer}</div>}
        </div>
      </div>
    </DialogPortal>
  );
}

function DialogPortal({ children }) {
  return createPortal(children, document.body);
}
