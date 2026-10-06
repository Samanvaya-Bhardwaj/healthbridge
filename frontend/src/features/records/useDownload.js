import { recordsApi } from '../../lib/domainApi.js';
import { useSafeMutation } from '../../lib/useSafeMutation.js';

/** Opens a short-lived signed URL (issued after authorisation) to download a file. */
export function useDownload() {
  return useSafeMutation({
    mutationFn: (id) => recordsApi.download(id),
    onSuccess: ({ url }) => {
      window.location.assign(url);
    },
  });
}
