import { QueryClient } from '@tanstack/react-query';

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Do not retry client errors (4xx); retry transient failures once.
        retry: (count, error) => (error?.status >= 400 && error?.status < 500 ? false : count < 1),
        refetchOnWindowFocus: false,
      },
    },
  });
}
