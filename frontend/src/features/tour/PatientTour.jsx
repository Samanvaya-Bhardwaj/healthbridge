import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../../components/ui/Button.jsx';
import { Dialog } from '../../components/ui/Dialog.jsx';
import { TOUR_STEPS } from './tourSteps.js';

const DIM = 'rgb(15 34 54 / 0.6)';
const MARGIN = 8;

/** Brings a step's element into view and follows it. Null: nothing to light up here. */
function useSpotlight(target) {
  const [rect, setRect] = useState();
  useEffect(() => {
    const element = target ? document.querySelector(`[data-tour="${target}"]`) : null;
    const measure = () => {
      const box = element?.getBoundingClientRect();
      setRect(box?.width && box.height ? box : null);
    };
    // To the top, so the card has the rest of the screen (scroll-margin clears the header).
    element?.scrollIntoView?.({ block: 'start' });
    const frame = requestAnimationFrame(measure);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [target]);
  return rect;
}

/**
 * The patient tour: large cards, one idea at a time, with the thing being described lit up
 * behind the card. It never leaves the page or clicks anything for the person. Next or Back
 * moves it; Skip or Escape ends it, and focus returns to where it started (Dialog).
 */
export function PatientTour({ onClose }) {
  const [index, setIndex] = useState(0);
  const next = useRef(null);
  // Focus stays on Next: Back leaves the card on the first step, and would take focus along.
  useEffect(() => next.current?.focus(), [index]);
  const step = TOUR_STEPS[index];
  const last = index === TOUR_STEPS.length - 1;
  const rect = useSpotlight(step.target);
  // The card sits away from what it describes.
  const lower = rect && rect.top + rect.height / 2 > window.innerHeight / 2;

  return (
    <>
      {createPortal(
        <div
          aria-hidden="true"
          data-testid="tour-spotlight"
          className={`fixed z-50 ${rect ? 'rounded-2xl ring-4 ring-accent' : 'inset-0'}`}
          style={
            rect
              ? {
                  top: rect.top - MARGIN,
                  left: rect.left - MARGIN,
                  width: rect.width + MARGIN * 2,
                  height: rect.height + MARGIN * 2,
                  boxShadow: `0 0 0 200vmax ${DIM}`,
                }
              : { background: DIM }
          }
        />,
        document.body,
      )}
      <Dialog
        open
        guide
        placement={rect ? (lower ? 'top' : 'bottom') : undefined}
        title={step.title}
        onClose={onClose}
        footer={
          <>
            <Button variant="ghost" onClick={onClose} className="mr-auto min-h-12 text-base">
              Skip tour
            </Button>
            {index > 0 && (
              <Button
                variant="secondary"
                onClick={() => setIndex(index - 1)}
                className="min-h-12 text-base"
              >
                Back
              </Button>
            )}
            <Button
              ref={next}
              data-autofocus
              onClick={() => (last ? onClose() : setIndex(index + 1))}
              className="min-h-12 text-base"
            >
              {last ? 'Finish' : 'Next'}
            </Button>
          </>
        }
      >
        {/* A lit-up tile already shows its picture; the card only needs one otherwise. */}
        {step.image && (!step.target || rect === null) && (
          <img
            src={step.image}
            alt=""
            width="720"
            height="480"
            className="mb-4 aspect-[3/2] max-h-[32vh] w-full rounded-2xl object-cover"
          />
        )}
        <div aria-live="polite">
          <p className="text-lg leading-relaxed text-text">
            <span className="sr-only">{step.title}. </span>
            {step.text}
          </p>
          <p className="mt-3 text-base font-medium text-text-muted">
            Step {index + 1} of {TOUR_STEPS.length}
          </p>
        </div>
      </Dialog>
    </>
  );
}
