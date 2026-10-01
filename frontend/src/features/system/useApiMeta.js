import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '../../lib/apiClient.js';

/** Public API metadata (version, demo mode). Used for the connectivity indicator. */
export function useApiMeta() {
  return useQuery({
    queryKey: ['system', 'meta'],
    queryFn: async ({ signal }) => (await apiRequest('/meta', { signal })).data,
    staleTime: 60_000,
    retry: 1,
  });
}
