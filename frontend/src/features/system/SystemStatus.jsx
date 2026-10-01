import { useApiMeta } from './useApiMeta.js';
import { Skeleton } from '../../components/ui/Skeleton.jsx';

/** Small, unobtrusive API connectivity indicator for the footer. */
export function SystemStatus() {
  const { data, isPending, isError } = useApiMeta();

  if (isPending) {
    return (
      <span className="inline-flex items-center gap-2" aria-busy="true">
        <Skeleton className="h-2 w-2 rounded-full" />
        <span className="sr-only">Checking service status</span>
        <Skeleton className="h-3 w-24" />
      </span>
    );
  }

  const online = !isError;
  return (
    <span role="status" className="inline-flex items-center gap-2 text-sm text-text-subtle">
      <span
        aria-hidden="true"
        className={`h-2 w-2 rounded-full ${online ? 'bg-success' : 'bg-warning'}`}
      />
      {online
        ? `Service online · API ${data.apiVersion} · v${data.version}`
        : 'Service unavailable'}
    </span>
  );
}
