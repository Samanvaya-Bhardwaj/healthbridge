import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ALL_ROLES,
  PERMISSIONS,
  ROLE_LABELS,
  ROLES,
  WORKFLOW_GRANTED_ROLES,
} from '@healthbridge/shared';
import { adminApi } from '../../lib/domainApi.js';
import { useAuth } from '../auth/authContext.js';
import { authErrorMessage } from '../auth/errorMessages.js';
import { Card } from '../../components/ui/Card.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { Badge, StatusBadge } from '../../components/ui/Badge.jsx';
import { Skeleton } from '../../components/ui/Skeleton.jsx';
import { EmptyState } from '../../components/ui/EmptyState.jsx';
import { SelectField } from '../../components/ui/SelectField.jsx';
import { controlClass } from '../../components/ui/fieldStyles.js';
import { PageHeader } from '../../components/ui/Typography.jsx';
import { Users } from 'lucide-react';

const roleOptions = ALL_ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }));
const STATUS_REASONS = [
  { value: 'security_concern', label: 'Security concern' },
  { value: 'user_request', label: 'User request' },
  { value: 'policy_violation', label: 'Policy violation' },
  { value: 'other', label: 'Other' },
];
/** Doctor and clinic roles come only from their workflows (verification, clinic admin). */
const GRANTABLE = ALL_ROLES.filter((r) => !WORKFLOW_GRANTED_ROLES.includes(r));
const when = (v) => (v ? new Date(v).toLocaleString('en-IN') : '—');

function UserDetail({ userId, onClose }) {
  const { user: me, hasPermission } = useAuth();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState(null);
  const [reason, setReason] = useState('security_concern');
  const [newRole, setNewRole] = useState(ROLES.SUPPORT);
  const detail = useQuery({
    queryKey: ['admin', 'user', userId],
    queryFn: () => adminApi.user(userId),
  });
  const refresh = (data, text) => {
    queryClient.setQueryData(['admin', 'user', userId], data);
    queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
    setMessage({ tone: 'success', text });
  };
  const onError = (error) => setMessage({ tone: 'error', text: authErrorMessage(error) });
  const status = useMutation({
    mutationFn: (next) =>
      adminApi.setUserStatus(userId, {
        status: next,
        reasonCode: next === 'active' ? 'reinstated' : reason,
      }),
    onSuccess: (data) =>
      refresh(data, data.status === 'disabled' ? 'Account disabled.' : 'Account reinstated.'),
    onError,
  });
  const grant = useMutation({
    mutationFn: (role) => adminApi.grantRole(userId, role),
    onSuccess: (data) => refresh(data, 'Role granted.'),
    onError,
  });
  const revoke = useMutation({
    mutationFn: (role) => adminApi.revokeRole(userId, role),
    onSuccess: (data) => refresh(data, 'Role removed.'),
    onError,
  });
  const sessions = useMutation({
    mutationFn: () => adminApi.revokeSessions(userId),
    onSuccess: (data) =>
      setMessage({ tone: 'success', text: `Signed out of ${data.revoked} session(s).` }),
    onError,
  });

  if (detail.isPending) return <Skeleton className="h-40" />;
  if (detail.isError) return <Alert tone="error">{authErrorMessage(detail.error)}</Alert>;
  const u = detail.data;
  const self = u.id === me.id;
  const canUpdate = hasPermission(PERMISSIONS.USERS_UPDATE) && !self;
  const canRoles = hasPermission(PERMISSIONS.ADMIN_USERS);
  const canSessions = hasPermission(PERMISSIONS.ADMIN_SESSIONS);
  const missing = GRANTABLE.filter((r) => !u.roles.includes(r));

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-text">{u.fullName}</h2>
          <p className="text-sm text-text-muted">{u.email}</p>
        </div>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
      <dl className="mt-4 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-text-subtle">Status</dt>
          <dd>
            <StatusBadge status={u.status} />
            {u.isDemo && (
              <span className="ml-2">
                <Badge>Demo</Badge>
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-text-subtle">Last sign-in</dt>
          <dd>{when(u.lastLoginAt)}</dd>
        </div>
        <div>
          <dt className="text-text-subtle">Email verified</dt>
          <dd>{when(u.emailVerifiedAt)}</dd>
        </div>
        <div>
          <dt className="text-text-subtle">Created</dt>
          <dd>{when(u.createdAt)}</dd>
        </div>
        {u.lockedUntil && new Date(u.lockedUntil) > new Date() && (
          <div>
            <dt className="text-text-subtle">Locked until</dt>
            <dd>{when(u.lockedUntil)}</dd>
          </div>
        )}
      </dl>

      <section className="mt-6" aria-labelledby="roles-heading">
        <h3 id="roles-heading" className="text-sm font-semibold text-text">
          Roles
        </h3>
        <ul className="mt-2 flex flex-wrap gap-2">
          {u.roles.map((r) => (
            <li key={r} className="flex items-center gap-1">
              <Badge tone="primary">{ROLE_LABELS[r] ?? r}</Badge>
              {canRoles && GRANTABLE.includes(r) && (
                <Button
                  variant="ghost"
                  aria-label={`Remove role ${ROLE_LABELS[r]}`}
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate(r)}
                >
                  Remove
                </Button>
              )}
            </li>
          ))}
          {u.roles.length === 0 && <li className="text-sm text-text-muted">No roles.</li>}
        </ul>
        {canRoles && missing.length > 0 && (
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <SelectField
              label="Grant a role"
              value={missing.includes(newRole) ? newRole : missing[0]}
              onChange={(e) => setNewRole(e.target.value)}
              options={missing.map((r) => ({ value: r, label: ROLE_LABELS[r] }))}
            />
            <Button
              variant="secondary"
              disabled={grant.isPending}
              onClick={() => grant.mutate(missing.includes(newRole) ? newRole : missing[0])}
            >
              Grant
            </Button>
          </div>
        )}
        <p className="mt-2 text-xs text-text-subtle">
          Doctor and clinic roles are granted only through verification and clinic administration.
          Administrator roles never include access to medical records.
        </p>
      </section>

      {(canUpdate || canSessions) && (
        <section className="mt-6 space-y-3" aria-labelledby="account-actions">
          <h3 id="account-actions" className="text-sm font-semibold text-text">
            Account actions
          </h3>
          {canUpdate && u.status === 'active' && (
            <div className="flex flex-wrap items-end gap-2">
              <SelectField
                label="Reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                options={STATUS_REASONS}
              />
              <Button
                variant="danger"
                disabled={status.isPending}
                onClick={() => status.mutate('disabled')}
              >
                Disable account
              </Button>
            </div>
          )}
          {canUpdate && u.status === 'disabled' && (
            <Button disabled={status.isPending} onClick={() => status.mutate('active')}>
              Reinstate account
            </Button>
          )}
          {canSessions && (
            <Button
              variant="secondary"
              disabled={sessions.isPending}
              onClick={() => sessions.mutate()}
            >
              Sign out everywhere
            </Button>
          )}
        </section>
      )}
      {message && (
        <Alert tone={message.tone} className="mt-4">
          {message.text}
        </Alert>
      )}
    </Card>
  );
}

/** Platform admin and support: account lookup and administration (every read is audited). */
export function UsersAdminPage() {
  const [draft, setDraft] = useState({ q: '', role: '', status: '' });
  const [filter, setFilter] = useState({ q: '', role: '', status: '' });
  const [selected, setSelected] = useState(null);
  const users = useInfiniteQuery({
    queryKey: ['admin', 'users', filter],
    queryFn: ({ pageParam }) => adminApi.users({ ...filter, cursor: pageParam }),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.meta?.nextCursor ?? undefined,
  });
  const rows = users.data?.pages.flatMap((p) => p.data) ?? [];
  const { hasPermission } = useAuth();
  const canAdminister = hasPermission(PERMISSIONS.USERS_UPDATE);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Users}
        eyebrow={canAdminister ? 'Administration' : 'Support'}
        title={canAdminister ? 'Users' : 'User lookup'}
        description={
          canAdminister
            ? 'Account lookup and administration. Every search and view is recorded in the audit log.'
            : 'Find an account to help someone sign in or find their way. You can view accounts but not change them; every lookup is recorded in the audit log.'
        }
      />
      <Card>
        <form
          className="grid gap-3 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            setSelected(null);
            setFilter({ ...draft, q: draft.q.trim().length >= 2 ? draft.q.trim() : '' });
          }}
        >
          <div>
            <label htmlFor="user-search" className="block text-sm font-medium text-text">
              Name or email
            </label>
            <input
              id="user-search"
              value={draft.q}
              onChange={(e) => setDraft({ ...draft, q: e.target.value })}
              placeholder="At least 2 characters"
              className={controlClass()}
            />
          </div>
          <SelectField
            label="Role"
            placeholder="Any role"
            value={draft.role}
            onChange={(e) => setDraft({ ...draft, role: e.target.value })}
            options={roleOptions}
          />
          <SelectField
            label="Status"
            placeholder="Any status"
            value={draft.status}
            onChange={(e) => setDraft({ ...draft, status: e.target.value })}
            options={[
              { value: 'active', label: 'Active' },
              { value: 'disabled', label: 'Disabled' },
            ]}
          />
          <Button type="submit">Search</Button>
        </form>
      </Card>

      {selected && <UserDetail userId={selected} onClose={() => setSelected(null)} />}

      {users.isPending ? (
        <Skeleton className="h-48" />
      ) : users.isError ? (
        <Alert tone="error">{authErrorMessage(users.error)}</Alert>
      ) : rows.length === 0 ? (
        <EmptyState title="No users found">Try a different name, email or filter.</EmptyState>
      ) : (
        <div className="relative overflow-x-auto rounded-2xl border border-border bg-surface-raised">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Users</caption>
            <thead className="border-b border-border text-text-subtle">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">
                  Name
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Roles
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Status
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((u) => (
                <tr key={u.id}>
                  <td className="px-4 py-3">
                    <div className="font-medium text-text">{u.fullName}</div>
                    <div className="text-text-subtle">{u.email}</div>
                  </td>
                  <td className="px-4 py-3">
                    {u.roles.map((r) => ROLE_LABELS[r] ?? r).join(', ') || '—'}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={u.status} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Button variant="ghost" onClick={() => setSelected(u.id)}>
                      View
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {users.hasNextPage && (
        <Button
          variant="secondary"
          disabled={users.isFetchingNextPage}
          onClick={() => users.fetchNextPage()}
        >
          Load more
        </Button>
      )}
    </div>
  );
}
