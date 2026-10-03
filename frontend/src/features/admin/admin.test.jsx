import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { App } from '../../app/App.jsx';
import { routes } from '../../app/routes.jsx';
import { createQueryClient } from '../../lib/queryClient.js';
import { setAccessToken } from '../../lib/apiClient.js';
import { reportClientError, resetErrorReporting, routeTemplate } from '../../lib/errorReporting.js';
import {
  clearCookies,
  fakeApi,
  json,
  makeUser,
  sessionPayload,
  setCookie,
} from '../../../tests/fakeApi.js';

const TARGET = '0192b6f0-0000-7000-8000-0000000000b2';
const ACTOR = '0192b6f0-0000-7000-8000-0000000000c3';
const PATIENT = '0192b6f0-0000-7000-8000-0000000000d4';
const target = (overrides = {}) => ({
  id: TARGET,
  email: 'ravi@test.healthbridge.local',
  fullName: 'Ravi Kumar',
  status: 'active',
  roles: ['PATIENT'],
  isDemo: false,
  lastLoginAt: '2026-10-01T10:00:00Z',
  lockedUntil: null,
  emailVerifiedAt: null,
  createdAt: '2026-09-01T10:00:00Z',
  ...overrides,
});

function signedIn(roles, routesMap) {
  setCookie('hb_csrf=csrf-1; path=/');
  const user = makeUser(roles, { fullName: 'Admin Synthetic' });
  return fakeApi({
    'POST /api/v1/auth/refresh': () => json(200, sessionPayload(user)),
    'GET /api/v1/auth/me': () => json(200, { data: user }),
    'GET /api/v1/notifications/unread-count': () => json(200, { data: { unreadCount: 0 } }),
    ...routesMap,
  });
}
const open = (path) =>
  render(
    <App
      router={createMemoryRouter(routes, { initialEntries: [path] })}
      queryClient={createQueryClient()}
    />,
  );

beforeEach(() => {
  clearCookies();
  setAccessToken(null);
});
afterEach(() => {
  clearCookies();
  vi.restoreAllMocks();
});

describe('user administration', () => {
  it('platform admin disables an account with a reason code and grants a role', async () => {
    const sent = [];
    let current = target();
    signedIn(['PLATFORM_ADMIN'], {
      'GET /api/v1/admin/users?limit=25': () =>
        json(200, { data: [current], meta: { nextCursor: null } }),
      [`GET /api/v1/admin/users/${TARGET}`]: () => json(200, { data: current }),
      [`PATCH /api/v1/admin/users/${TARGET}/status`]: (init) => {
        sent.push(JSON.parse(init.body));
        current = target({ status: 'disabled' });
        return json(200, { data: current });
      },
      [`PUT /api/v1/admin/users/${TARGET}/roles/SUPPORT`]: () => {
        current = { ...current, roles: ['PATIENT', 'SUPPORT'] };
        return json(200, { data: current });
      },
    });
    open('/app/admin/users');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'View' }));
    expect(await screen.findByRole('heading', { name: 'Ravi Kumar' })).toBeInTheDocument();

    // Doctor and clinic roles are never offered (they come from workflows).
    const grant = screen.getByLabelText('Grant a role');
    const offered = within(grant)
      .getAllByRole('option')
      .map((o) => o.value);
    expect(offered).not.toContain('DOCTOR');
    expect(offered).not.toContain('CLINIC_ADMIN');

    await user.selectOptions(screen.getByLabelText('Reason'), 'policy_violation');
    await user.click(screen.getByRole('button', { name: 'Disable account' }));
    expect(await screen.findByText('Account disabled.')).toBeInTheDocument();
    expect(sent).toEqual([{ status: 'disabled', reasonCode: 'policy_violation' }]);
    expect(screen.getByRole('button', { name: 'Reinstate account' })).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Grant a role'), 'SUPPORT');
    await user.click(screen.getByRole('button', { name: 'Grant' }));
    expect(await screen.findByText('Role granted.')).toBeInTheDocument();
  });

  it('support can look accounts up but sees no account actions or audit log', async () => {
    signedIn(['SUPPORT'], {
      'GET /api/v1/admin/users?limit=25': () =>
        json(200, { data: [target()], meta: { nextCursor: null } }),
      [`GET /api/v1/admin/users/${TARGET}`]: () => json(200, { data: target() }),
    });
    open('/app/admin/users');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'View' }));
    await screen.findByRole('heading', { name: 'Ravi Kumar' });
    expect(screen.queryByRole('button', { name: 'Disable account' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Grant a role')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign out everywhere' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Audit Log' })).not.toBeInTheDocument();
  });
});

describe('audit log viewer', () => {
  const entry = {
    id: '0192b6f0-0000-7000-8000-0000000000e5',
    occurredAt: '2026-10-02T09:00:00Z',
    category: 'data_access',
    action: 'document.download',
    outcome: 'denied',
    actor: { type: 'user', userId: ACTOR, roles: ['DOCTOR'] },
    sessionId: null,
    resource: { type: 'medical_document', id: '0192b6f0-0000-7000-8000-0000000000f6' },
    patientId: PATIENT,
    reason: 'consent_required',
    requestId: 'req-0001',
    ip: '127.0.0.1',
    userAgent: 'Synthetic',
    metadata: { scope: 'medical_documents' },
  };

  it('lists entries, narrows by actor and validates filters before calling the API', async () => {
    const calls = signedIn(['PLATFORM_ADMIN'], {
      'GET /api/v1/admin/audit-logs?limit=50': () =>
        json(200, { data: [entry], meta: { nextCursor: null } }),
      [`GET /api/v1/admin/audit-logs?actorUserId=${ACTOR}&limit=50`]: () =>
        json(200, { data: [entry], meta: { nextCursor: null } }),
    });
    open('/app/admin/audit');
    const user = userEvent.setup();
    expect(await screen.findByText('document.download')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByText(/"scope": "medical_documents"/)).toBeInTheDocument();

    await user.click(screen.getByTitle('Show only this actor'));
    expect(await screen.findByLabelText('Actor (user ID)')).toHaveValue(ACTOR);
    expect(calls.some((c) => c.key.includes(`actorUserId=${ACTOR}`))).toBe(true);

    const before = calls.length;
    await user.type(screen.getByLabelText('Patient ID'), 'Asha Rao');
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(await screen.findByText('Patient must be a patient ID.')).toBeInTheDocument();
    expect(calls.slice(before).some((c) => c.key.includes('audit-logs'))).toBe(false);
  });
});

describe('operations', () => {
  it('shows queue health and retries a dead-lettered job', async () => {
    let retried = false;
    signedIn(['PLATFORM_ADMIN'], {
      'GET /api/v1/admin/operations/summary': () =>
        json(200, {
          data: {
            outbox: { dispatched: 120, pending: 1 },
            deadLetters: retried ? { retried: 1 } : { open: 1 },
            queues: { notifications: { waiting: 0, active: 1, delayed: 0, failed: 2 } },
          },
        }),
      'GET /api/v1/admin/operations/dead-letters?status=open': () =>
        json(200, {
          data: retried
            ? []
            : [
                {
                  id: 'dl-1',
                  queue: 'notifications',
                  jobName: 'appointment.booked',
                  attempts: 6,
                  failureReason: 'SMTP unavailable',
                  aggregateType: 'appointment',
                  failedAt: '2026-10-02T09:00:00Z',
                  status: 'open',
                },
              ],
        }),
      'POST /api/v1/admin/operations/dead-letters/dl-1/retry': () => {
        retried = true;
        return json(200, { data: { id: 'dl-1', status: 'retried' } });
      },
    });
    open('/app/admin/operations');
    const user = userEvent.setup();
    expect(await screen.findByText('SMTP unavailable')).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: 'notifications' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Job queued again.')).toBeInTheDocument();
    expect(await screen.findByText('Nothing needs attention')).toBeInTheDocument();
  });
});

describe('browser error reporting', () => {
  it('sends the error class and route template only', async () => {
    resetErrorReporting();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
    window.history.pushState({}, '', `/app/medical-records/${PATIENT}?q=asthma#x`);
    expect(routeTemplate()).toBe('/app/medical-records/:id');
    const error = new TypeError('Cannot read properties of Asha Rao asthma record');
    reportClientError('render_error', error);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/v1/telemetry/client-errors');
    expect(JSON.parse(init.body)).toEqual({
      kind: 'render_error',
      name: 'TypeError',
      path: '/app/medical-records/:id',
    });
    expect(init.body).not.toMatch(/Asha|asthma/);
    expect(init.credentials).toBe('omit');

    for (let i = 0; i < 20; i += 1) reportClientError('window_error', error);
    expect(fetchSpy).toHaveBeenCalledTimes(10); // capped per page load
    window.history.pushState({}, '', '/');
  });
});
