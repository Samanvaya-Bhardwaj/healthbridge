import { Link } from 'react-router';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { inboxApi } from '../../lib/domainApi.js';
import { authErrorMessage } from '../auth/errorMessages.js';
import { Alert } from '../../components/ui/Alert.jsx';
import { Badge } from '../../components/ui/Badge.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { Card } from '../../components/ui/Card.jsx';
import { EmptyState } from '../../components/ui/EmptyState.jsx';
import { Skeleton } from '../../components/ui/Skeleton.jsx';
import { formatDateTime } from '../appointments/format.js';

/** Header link to the inbox with the unread count (refreshed every minute). */
export function NotificationBell() {
  const count = useQuery({
    queryKey: ['inbox-unread'],
    queryFn: inboxApi.unreadCount,
    refetchInterval: 60_000,
    retry: false,
  });
  const unread = count.data?.unreadCount ?? 0;
  return (
    <Link
      to="/app/notifications"
      className="relative inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-medium text-text-muted hover:bg-surface-muted hover:text-text"
      aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
    >
      Notifications
      {unread > 0 && (
        <span className="ml-2 rounded-full bg-primary px-2 py-0.5 text-xs font-semibold text-primary-contrast">
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </Link>
  );
}

/** In-app inbox: generic notices; each opens the relevant page. */
export function InboxPage() {
  const queryClient = useQueryClient();
  const pages = useInfiniteQuery({
    queryKey: ['inbox'],
    queryFn: ({ pageParam }) => inboxApi.list({ limit: 20, cursor: pageParam }),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.meta?.nextCursor ?? undefined,
  });
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['inbox'] });
    queryClient.invalidateQueries({ queryKey: ['inbox-unread'] });
  };
  const read = useMutation({ mutationFn: inboxApi.read, onSuccess: refresh });
  const readAll = useMutation({ mutationFn: inboxApi.readAll, onSuccess: refresh });
  const items = pages.data?.pages.flatMap((p) => p.data) ?? [];
  const unread = pages.data?.pages[0]?.meta?.unreadCount ?? 0;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-text">Notifications</h1>
          <p className="mt-2 text-text-muted">
            {unread ? `${unread} unread` : 'You are all caught up.'}
          </p>
        </div>
        {unread > 0 && (
          <Button variant="secondary" onClick={() => readAll.mutate()} disabled={readAll.isPending}>
            Mark all as read
          </Button>
        )}
      </div>
      {pages.isPending && <Skeleton className="h-24 w-full" />}
      {pages.isError && <Alert tone="error">{authErrorMessage(pages.error)}</Alert>}
      {pages.isSuccess && items.length === 0 && (
        <EmptyState title="No notifications yet">
          Booking, payment, record and follow-up updates appear here.
        </EmptyState>
      )}
      <ul className="space-y-2">
        {items.map((n) => (
          <li key={n.id}>
            <Card>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-text">
                    {!n.readAt && (
                      <span className="h-2 w-2 rounded-full bg-primary" aria-label="Unread" />
                    )}
                    {n.title}
                    {n.priority === 'urgent' && <Badge tone="danger">Urgent</Badge>}
                  </p>
                  <p className="mt-1 text-sm text-text-muted">{n.body}</p>
                  <p className="mt-1 text-xs text-text-subtle">{formatDateTime(n.createdAt)}</p>
                </div>
                <div className="flex gap-2">
                  {n.link && (
                    <Link
                      to={n.link}
                      onClick={() => !n.readAt && read.mutate(n.id)}
                      className="min-h-11 rounded-lg border border-border px-3 py-2.5 text-sm font-medium text-text hover:bg-surface-muted"
                    >
                      Open
                    </Link>
                  )}
                  {!n.readAt && (
                    <Button variant="ghost" onClick={() => read.mutate(n.id)}>
                      Mark read
                    </Button>
                  )}
                </div>
              </div>
            </Card>
          </li>
        ))}
      </ul>
      {pages.hasNextPage && (
        <Button
          variant="secondary"
          onClick={() => pages.fetchNextPage()}
          disabled={pages.isFetchingNextPage}
        >
          Load more
        </Button>
      )}
    </div>
  );
}
