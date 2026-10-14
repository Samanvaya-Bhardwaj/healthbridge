import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from './queryClient.js';
import { useSafeMutation } from './useSafeMutation.js';

const wrapper = ({ children }) => (
  <QueryClientProvider client={createQueryClient()}>{children}</QueryClientProvider>
);

describe('useSafeMutation', () => {
  it('ignores a second submit while one is in flight', async () => {
    const calls = [];
    let release;
    const { result } = renderHook(
      () =>
        useSafeMutation({
          mutationFn: (v) => {
            calls.push(v);
            return new Promise((resolve) => {
              release = resolve;
            });
          },
        }),
      { wrapper },
    );
    act(() => {
      result.current.mutate('a');
      result.current.mutate('b');
    });
    await waitFor(() => expect(calls).toEqual(['a']));
    await act(async () => release());
  });

  it('accepts a new call after reset() during a call in flight', async () => {
    const calls = [];
    const { result } = renderHook(
      () =>
        useSafeMutation({
          mutationFn: (v) => {
            calls.push(v);
            return v === 'first' ? new Promise(() => {}) : Promise.resolve(v);
          },
        }),
      { wrapper },
    );
    act(() => result.current.mutate('first'));
    await waitFor(() => expect(calls).toEqual(['first']));
    act(() => result.current.reset());
    act(() => result.current.mutate('second'));
    await waitFor(() => expect(result.current.data).toBe('second'));
    expect(calls).toEqual(['first', 'second']);
  });
});
