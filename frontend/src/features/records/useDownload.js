import { useMutation } from '@tanstack/react-query';
import { recordsApi } from '../../lib/domainApi.js';

/** Opens a short-lived signed URL (issued after authorisation) to download a file. */
export function useDownload() {
  return useMutation({
    mutationFn: (id) => recordsApi.download(id),
    onSuccess: ({ url }) => {
      window.location.assign(url);
    },
  });
}
