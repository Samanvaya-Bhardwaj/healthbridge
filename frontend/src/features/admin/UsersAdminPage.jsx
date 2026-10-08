import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { ActionDialog, PlatformBoundary } from './AdminParts.jsx';
import { useSafeMutation } from '../../lib/useSafeMutation.js';
import { formatFullDateTime } from '../appointments/format.js';

const roleOptions = ALL_ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }));
const STATUS_REASONS = [
  { value: 'security_concern', label: 'Security concern' },
  { value: 'user_request', label: 'User request' },
  { value: 'policy_violation', label: 'Policy violation' },
  { value: 'other', label: 'Other' },
];
/** Doctor and clinic roles come only from their workflows (verification, clinic admin). */
const GRANTABLE = ALL_ROLES.filter((r) => !WORKFLOW_GRANTED_ROLES.includes(r));
const when = (v) => (v ? formatFullDateTime(v) : '—');

function UserDetail({ userId, onClose }) {
  const { user: me, hasPermission } = useAuth();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState(null);
  const [newRole, setNewRole] = useState(ROLES.SUPPORT);
  const [dialog, setDialog] = useState(null);
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
  const status = useSafeMutation({
    mutationFn: ({ next, reasonCode }) =>
      adminApi.setUserStatus(userId, {
        status: next,
        reasonCode: next === 'active' ? 'reinstated' : reasonCode,
      }),
    onSuccess: (data) => {
      setDialog(null);
      refresh(
        data,
        data.status === 'disabled'
          ? 'Account disabled. The person was signed out everywhere and cannot sign in.'
          : 'Account reinstated. The person can sign in again.',
      );
    },
    onError,
  });
  const grant = useSafeMutation({
    mutationFn: (role) => adminApi.grantRole(userId, role),
    onSuccess: (data) => {
      setDialog(null);
      refresh(data, 'Role granted. It applies from their next sign-in or token refresh.');
    },
    onError,
  });
  const revoke = useSafeMutation({
    mutationFn: (role) => adminApi.revokeRole(userId, role),
    onSuccess: (data) => {
      setDialog(null);
      refresh(data, 'Role removed.');
    },
    onError,
  });
  const sessions = useSafeMutation({
    mutationFn: () => adminApi.revokeSessions(userId),
    onSuccess: (data) => {
      setDialog(null);
      setMessage({ tone: 'success', text: `Signed out of ${data.revoked} session(s).` });
    },
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
      <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
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
                  onClick={() => setDialog({ kind: 'revoke', role: r })}
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
              onClick={() =>
                setDialog({ kind: 'grant', role: missing.includes(newRole) ? newRole : missing[0] })
              }
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
          <p className="text-sm text-text-muted">
            {u.status === 'active'
              ? 'Active: the person can sign in.'
              : 'Disabled: the person cannot sign in until the account is reinstated.'}
          </p>
          <div className="flex flex-wrap gap-2">
            {canUpdate && u.status === 'active' && (
              <Button variant="danger" onClick={() => setDialog({ kind: 'disable' })}>
                Disable account
              </Button>
            )}
            {canUpdate && u.status === 'disabled' && (
              <Button onClick={() => setDialog({ kind: 'reinstate' })}>Reinstate account</Button>
            )}
            {canSessions && (
              <Button variant="secondary" onClick={() => setDialog({ kind: 'sessions' })}>
                Sign out everywhere
              </Button>
            )}
          </div>
          {self && <p className="text-xs text-text-subtle">You can’t disable your own account.</p>}
        </section>
      )}
      {dialog?.kind === 'disable' && (
        <ActionDialog
          title={`Disable ${u.fullName}’s account?`}
          description="They are signed out of every device at once and cannot sign in until the account is reinstated. Their data is not deleted."
          confirmLabel="Disable account"
          reasons={STATUS_REASONS}
          reasonLabel="Why are you disabling it?"
          destructive
          pending={status.isPending}
          error={status.error}
          onConfirm={({ reasonCode }) => status.mutate({ next: 'disabled', reasonCode })}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'reinstate' && (
        <ActionDialog
          title={`Reinstate ${u.fullName}’s account?`}
          description="They can sign in again with their existing password. This is recorded as “reinstated” in the audit log."
          confirmLabel="Reinstate account"
          pending={status.isPending}
          error={status.error}
          onConfirm={() => status.mutate({ next: 'active' })}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'sessions' && (
        <ActionDialog
          title={`Sign ${u.fullName} out everywhere?`}
          description="Every signed-in device is signed out at once. Use this after a lost device or a suspected compromise. They can sign in again with their password."
          confirmLabel="Sign out everywhere"
          destructive
          pending={sessions.isPending}
          error={sessions.error}
          onConfirm={() => sessions.mutate()}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'grant' && (
        <ActionDialog
          title={`Give ${u.fullName} the ${ROLE_LABELS[dialog.role]} role?`}
          description="Roles decide what someone can do. Administrator and support roles never include access to medical records."
          confirmLabel="Grant role"
          pending={grant.isPending}
          error={grant.error}
          onConfirm={() => grant.mutate(dialog.role)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'revoke' && (
        <ActionDialog
          title={`Remove the ${ROLE_LABELS[dialog.role]} role from ${u.fullName}?`}
          description="They lose what this role allows. The platform always keeps at least one platform administrator."
          confirmLabel="Remove role"
          destructive
          pending={revoke.isPending}
          error={revoke.error}
          onConfirm={() => revoke.mutate(dialog.role)}
          onClose={() => setDialog(null)}
        />
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
  const [params] = useSearchParams();
  const initial = {
    q: params.get('q') ?? '',
    role: params.get('role') ?? '',
    status: params.get('status') ?? '',
  };
  const [draft, setDraft] = useState(initial);
  const [filter, setFilter] = useState(initial);
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
      {canAdminister && <PlatformBoundary compact />}
      <Card>
        <form
          className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end"
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
        <div
          role="region"
          aria-label="Users table"
          tabIndex={0}
          className="relative overflow-x-auto rounded-2xl border border-border bg-surface-raised"
        >
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Users</caption>
            <thead className="border-b border-border text-text-subtle">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">
                  Name
                </th>
                <th scope="col" className="hidden px-4 py-3 font-medium sm:table-cell">
                  Roles
                </th>
                <th scope="col" className="hidden px-4 py-3 font-medium sm:table-cell">
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
                    <button
                      type="button"
                      onClick={() => setSelected(u.id)}
                      className="text-left font-medium text-text hover:text-primary"
                    >
                      {u.fullName}
                    </button>
                    <div className="break-all text-text-subtle">{u.email}</div>
                    {/* Small screens: roles and status under the name, no sideways scroll. */}
                    <div className="mt-1 flex flex-wrap items-center gap-2 sm:hidden">
                      <StatusBadge status={u.status} />
                      <span className="text-xs text-text-muted">
                        {u.roles.map((r) => ROLE_LABELS[r] ?? r).join(', ')}
                      </span>
                    </div>
                  </td>
                  <td className="hidden px-4 py-3 sm:table-cell">
                    {u.roles.map((r) => ROLE_LABELS[r] ?? r).join(', ') || '—'}
                  </td>
                  <td className="hidden px-4 py-3 sm:table-cell">
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
