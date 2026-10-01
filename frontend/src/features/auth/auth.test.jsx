import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { App } from '../../app/App.jsx';
import { routes } from '../../app/routes.jsx';
import { createQueryClient } from '../../lib/queryClient.js';
import { setAccessToken } from '../../lib/apiClient.js';
import {
  clearCookies,
  fakeApi,
  json,
  makeUser,
  problem,
  sessionPayload,
  setCookie,
} from '../../../tests/fakeApi.js';

function renderAt(path) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={createQueryClient()} />);
  return router;
}

beforeEach(() => {
  clearCookies();
  setAccessToken(null);
});
afterEach(() => clearCookies());

describe('protected routes', () => {
  it('redirects anonymous visitors from /app to sign-in', async () => {
    fakeApi({});
    const router = renderAt('/app');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
  });
});

describe('sign in', () => {
  it('signs in and shows the patient workspace with patient navigation', async () => {
    const user = makeUser(['PATIENT']);
    const calls = fakeApi({
      'POST /api/v1/auth/login': () => json(200, sessionPayload(user)),
      'GET /api/v1/auth/me': () => json(200, { data: user }),
    });
    renderAt('/login');
    const ue = userEvent.setup();
    await ue.type(screen.getByLabelText('Email'), 'asha@demo.healthbridge.local');
    await ue.type(screen.getByLabelText('Password'), 'river lantern quiet mango');
    await ue.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { name: 'Welcome, Asha' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    for (const label of ['Home', 'Appointments', 'Health Records', 'Doctors', 'Profile']) {
      expect(within(nav).getByRole('link', { name: label })).toBeInTheDocument();
    }
    expect(within(nav).queryByRole('link', { name: 'Prescriptions' })).not.toBeInTheDocument();

    const me = calls.find((c) => c.key === 'GET /api/v1/auth/me');
    expect(me.init.headers.authorization).toBe('Bearer access-token-1');
    const loginCall = calls.find((c) => c.key === 'POST /api/v1/auth/login');
    expect(loginCall.init.headers.authorization).toBeUndefined();
  });

  it('shows a generic message for invalid credentials', async () => {
    fakeApi({ 'POST /api/v1/auth/login': () => problem(401, 'invalid_credentials') });
    renderAt('/login');
    const ue = userEvent.setup();
    await ue.type(screen.getByLabelText('Email'), 'someone@example.test');
    await ue.type(screen.getByLabelText('Password'), 'wrong');
    await ue.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password.');
  });

  it('validates input before calling the API', async () => {
    const calls = fakeApi({});
    renderAt('/login');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Email is required.')).toBeInTheDocument();
    expect(calls.some((c) => c.key.includes('/auth/login'))).toBe(false);
  });
});

describe('registration', () => {
  it('registers and returns to sign-in with the neutral server message', async () => {
    const calls = fakeApi({
      'POST /api/v1/auth/register': () =>
        json(202, { data: { status: 'received', message: 'Thanks. If this email can be used…' } }),
    });
    renderAt('/register');
    const ue = userEvent.setup();
    await ue.type(screen.getByLabelText('Full name'), 'Asha Rao');
    await ue.type(screen.getByLabelText('Email'), 'asha@demo.healthbridge.local');
    await ue.type(screen.getByLabelText('Password'), 'river lantern quiet mango');
    await ue.click(screen.getByRole('checkbox'));
    await ue.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByText(/Thanks\. If this email can be used/)).toBeInTheDocument();
    const body = JSON.parse(calls.find((c) => c.key === 'POST /api/v1/auth/register').init.body);
    expect(body).toEqual({
      fullName: 'Asha Rao',
      email: 'asha@demo.healthbridge.local',
      password: 'river lantern quiet mango',
      acceptTerms: true,
    });
  });

  it('enforces the password length and terms acceptance client-side', async () => {
    fakeApi({});
    renderAt('/register');
    const ue = userEvent.setup();
    await ue.type(screen.getByLabelText('Password'), 'short');
    await ue.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Use at least 12 characters.')).toBeInTheDocument();
    expect(screen.getByText('You must accept the terms and privacy notice.')).toBeInTheDocument();
  });

  it('shows server-side password policy errors on the field', async () => {
    fakeApi({
      'POST /api/v1/auth/register': () =>
        json(400, {
          status: 400,
          code: 'validation_failed',
          errors: [
            {
              path: 'body.password',
              message: 'This password is too common. Choose a different one.',
            },
          ],
        }),
    });
    renderAt('/register');
    const ue = userEvent.setup();
    await ue.type(screen.getByLabelText('Full name'), 'Asha Rao');
    await ue.type(screen.getByLabelText('Email'), 'asha@demo.healthbridge.local');
    await ue.type(screen.getByLabelText('Password'), 'password123456');
    await ue.click(screen.getByRole('checkbox'));
    await ue.click(screen.getByRole('button', { name: 'Create account' }));
    expect(
      await screen.findByText('This password is too common. Choose a different one.'),
    ).toBeInTheDocument();
  });
});

describe('session restoration and lifecycle', () => {
  it('restores a session on load using the refresh cookie and CSRF header', async () => {
    setCookie('hb_csrf=csrf-123; path=/');
    const user = makeUser(['DOCTOR']);
    const calls = fakeApi({
      'POST /api/v1/auth/refresh': () => json(200, sessionPayload(user)),
      'GET /api/v1/auth/me': () => json(200, { data: user }),
    });
    renderAt('/app');
    expect(await screen.findByRole('heading', { name: 'Welcome, Asha' })).toBeInTheDocument();
    const refresh = calls.find((c) => c.key === 'POST /api/v1/auth/refresh');
    expect(refresh.init.headers['x-csrf-token']).toBe('csrf-123');
    expect(refresh.init.credentials).toBe('same-origin');

    const nav = screen.getByRole('navigation', { name: 'Main' });
    for (const label of [
      'Dashboard',
      'Patients',
      'Medical Records',
      'Consultations',
      'Prescriptions',
      'Follow-ups',
    ]) {
      expect(within(nav).getByRole('link', { name: label })).toBeInTheDocument();
    }
  });

  it('shows the unauthorized state for sections outside the role', async () => {
    setCookie('hb_csrf=csrf-123; path=/');
    const user = makeUser(['PATIENT']);
    fakeApi({
      'POST /api/v1/auth/refresh': () => json(200, sessionPayload(user)),
      'GET /api/v1/auth/me': () => json(200, { data: user }),
    });
    renderAt('/app/prescriptions');
    expect(
      await screen.findByRole('heading', { name: 'You don’t have access to this page' }),
    ).toBeInTheDocument();
  });

  it('signs out and returns to sign-in', async () => {
    setCookie('hb_csrf=csrf-123; path=/');
    const user = makeUser(['PATIENT']);
    const calls = fakeApi({
      'POST /api/v1/auth/refresh': () => json(200, sessionPayload(user)),
      'GET /api/v1/auth/me': () => json(200, { data: user }),
      'POST /api/v1/auth/logout': () => json(204, null),
    });
    const router = renderAt('/app');
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('You have signed out.')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
    expect(
      calls.find((c) => c.key === 'POST /api/v1/auth/logout').init.headers['x-csrf-token'],
    ).toBe('csrf-123');
  });

  it('refreshes once on an expired access token and retries the request', async () => {
    setCookie('hb_csrf=csrf-123; path=/');
    const user = makeUser(['PATIENT']);
    let refreshes = 0;
    let meCalls = 0;
    fakeApi({
      'POST /api/v1/auth/refresh': () => {
        refreshes += 1;
        return json(200, sessionPayload(user, `access-token-${refreshes}`));
      },
      'GET /api/v1/auth/me': (init) => {
        meCalls += 1;
        // The second call (with the first token) is rejected as expired.
        if (meCalls === 1) return json(200, { data: user });
        return init.headers.authorization === 'Bearer access-token-1'
          ? problem(401, 'token_expired')
          : json(200, { data: user });
      },
      'GET /api/v1/auth/sessions': () => json(200, { data: [] }),
    });
    renderAt('/app');
    await screen.findByRole('heading', { name: 'Welcome, Asha' });
    const { fetchMe } = await import('./authApi.js');
    await expect(fetchMe()).resolves.toMatchObject({ email: user.email });
    expect(refreshes).toBe(2);
  });

  it('ends the session with a clear message when refresh fails', async () => {
    setCookie('hb_csrf=csrf-123; path=/');
    const user = makeUser(['PATIENT']);
    let refreshes = 0;
    fakeApi({
      'POST /api/v1/auth/refresh': () => {
        refreshes += 1;
        return refreshes === 1 ? json(200, sessionPayload(user)) : problem(401, 'session_invalid');
      },
      'GET /api/v1/auth/me': () => json(200, { data: user }),
      'GET /api/v1/auth/sessions': () => problem(401, 'session_invalid'),
    });
    renderAt('/app/account');
    expect(
      await screen.findByText('Your session has ended. Please sign in again.'),
    ).toBeInTheDocument();
  });

  it('restoration failure leaves the visitor signed out without an error', async () => {
    setCookie('hb_csrf=stale; path=/');
    fakeApi({ 'POST /api/v1/auth/refresh': () => problem(401, 'session_invalid') });
    renderAt('/app');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
});
