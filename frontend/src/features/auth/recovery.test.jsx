import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { App } from '../../app/App.jsx';
import { routes } from '../../app/routes.jsx';
import { createQueryClient } from '../../lib/queryClient.js';
import { setAccessToken } from '../../lib/apiClient.js';
import { clearCookies, fakeApi, json, problem } from '../../../tests/fakeApi.js';

const TOKEN = `0192b6f0-0000-7000-8000-0000000000a1.${'x'.repeat(43)}`;
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
  window.history.replaceState(null, '', '/');
  vi.restoreAllMocks();
});

describe('account recovery', () => {
  it('requests a reset link with the same answer for every email', async () => {
    let body = null;
    fakeApi({
      'POST /api/v1/auth/password/forgot': (init) => {
        body = JSON.parse(init.body);
        return json(202, {
          data: { status: 'received', message: 'If an account uses this email…' },
        });
      },
    });
    open('/login');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('link', { name: 'Forgot your password?' }));
    await user.type(screen.getByLabelText('Email'), 'Asha@Example.com');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByText('If an account uses this email…')).toBeInTheDocument();
    expect(body).toEqual({ email: 'asha@example.com' });
  });

  it('reads the token from the fragment, removes it from the URL and sets a new password', async () => {
    const calls = fakeApi({
      'POST /api/v1/auth/password/reset': () => json(200, { data: { status: 'password_reset' } }),
    });
    window.history.replaceState(null, '', `/reset-password#token=${TOKEN}`);
    open('/reset-password');
    expect(window.location.hash).toBe('');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('New password'), 'quiet harbour violet 2026');
    await user.type(screen.getByLabelText('Confirm new password'), 'quiet harbour violet 2027');
    await user.click(screen.getByRole('button', { name: 'Set new password' }));
    expect(await screen.findByText('The passwords do not match.')).toBeInTheDocument();

    await user.clear(screen.getByLabelText('Confirm new password'));
    await user.type(screen.getByLabelText('Confirm new password'), 'quiet harbour violet 2026');
    await user.click(screen.getByRole('button', { name: 'Set new password' }));
    expect(await screen.findByText(/signed out everywhere/)).toBeInTheDocument();
    const sent = calls.find((c) => c.key === 'POST /api/v1/auth/password/reset');
    expect(JSON.parse(sent.init.body)).toEqual({
      token: TOKEN,
      newPassword: 'quiet harbour violet 2026',
    });
    expect(sent.init.headers.authorization).toBeUndefined();
  });

  it('explains expired links and incomplete links', async () => {
    fakeApi({
      'POST /api/v1/auth/password/reset': () =>
        problem(
          400,
          'invalid_token',
          'This reset link is invalid or has expired. Request a new one.',
        ),
    });
    window.history.replaceState(null, '', `/reset-password#token=${TOKEN}`);
    const first = open('/reset-password');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('New password'), 'quiet harbour violet 2026');
    await user.type(screen.getByLabelText('Confirm new password'), 'quiet harbour violet 2026');
    await user.click(screen.getByRole('button', { name: 'Set new password' }));
    expect(await screen.findByText(/invalid or has expired/)).toBeInTheDocument();
    first.unmount();

    window.history.replaceState(null, '', '/reset-password#token=bogus');
    open('/reset-password');
    expect(await screen.findByText(/This reset link is incomplete/)).toBeInTheDocument();
  });

  it('confirms an email exactly once', async () => {
    const calls = fakeApi({
      'POST /api/v1/auth/email/verify': () => json(200, { data: { status: 'verified' } }),
    });
    window.history.replaceState(null, '', `/verify-email#token=${TOKEN}`);
    open('/verify-email');
    expect(await screen.findByText(/your email is confirmed/)).toBeInTheDocument();
    expect(calls.filter((c) => c.key === 'POST /api/v1/auth/email/verify')).toHaveLength(1);
  });
});
