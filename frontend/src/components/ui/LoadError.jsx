import { RotateCw } from 'lucide-react';
import { authErrorMessage } from '../../features/auth/errorMessages.js';
import { Alert } from './Alert.jsx';
import { Button } from './Button.jsx';

/**
 * Shown when part of a page could not be loaded: says what is missing in plain words,
 * never a status code, and offers to try again (refetching only what failed).
 *
 * @param {{ queries: Array<{ isError: boolean, error: unknown, isFetching: boolean, refetch: () => unknown }>, what: string, className?: string }} props
 */
export function LoadError({ queries, what, className = '' }) {
  const failed = queries.filter((q) => q?.isError);
  if (!failed.length) return null;
  const retrying = failed.some((q) => q.isFetching);
  return (
    <Alert
      tone="error"
      title={`We couldn’t load ${what}.`}
      className={className}
      action={
        <Button
          size="sm"
          variant="secondary"
          icon={RotateCw}
          loading={retrying}
          onClick={() => failed.forEach((q) => q.refetch())}
        >
          Try again
        </Button>
      }
    >
      {authErrorMessage(failed[0].error)}
    </Alert>
  );
}
