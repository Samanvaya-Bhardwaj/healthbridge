import { useCallback, useRef } from 'react';
import { useMutation } from '@tanstack/react-query';

/**
 * useMutation that cannot be submitted twice. A disabled button only takes effect after
 * React re-renders, so a fast double click (or a slow network) can still send a second
 * request; this guard is synchronous and drops any call while one is in flight.
 * Server-side idempotency keys (booking, refunds) remain the final protection.
 *
 * @type {typeof useMutation}
 */
export function useSafeMutation(options, queryClient) {
  const mutation = useMutation(options, queryClient);
  const inFlight = useRef(false);
  const { mutate: rawMutate } = mutation;
  const mutate = useCallback(
    (variables, callbacks) => {
      if (inFlight.current) return;
      inFlight.current = true;
      rawMutate(variables, {
        ...callbacks,
        onSettled: (...args) => {
          inFlight.current = false;
          callbacks?.onSettled?.(...args);
        },
      });
    },
    [rawMutate],
  );
  return { ...mutation, mutate };
}
