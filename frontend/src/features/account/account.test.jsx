import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
  sessionPayload,
  setCookie,
} from '../../../tests/fakeApi.js';

beforeEach(() => {
  clearCookies();
  setAccessToken(null);
});
afterEach(() => clearCookies());

const ALL_ON = {
  email: { appointments: true, payments: true, reminders: true, documents: true, follow_ups: true },
  sms: true,
};

describe('account settings: notifications (step 8)', () => {
  it('shows the current choices, saves a change, and says what is always sent', async () => {
    setCookie('hb_csrf=csrf-1; path=/');
    const user = makeUser(['PATIENT']);
    const calls = fakeApi({
      'POST /api/v1/auth/refresh': () => json(200, sessionPayload(user)),
      'GET /api/v1/auth/me': () => json(200, { data: user }),
      'GET /api/v1/notifications/unread-count': () => json(200, { data: { unreadCount: 0 } }),
      'GET /api/v1/users/me': () =>
        json(200, { data: { ...user, emailVerifiedAt: '2026-10-01T00:00:00Z' } }),
      'GET /api/v1/auth/sessions': () => json(200, { data: [] }),
      'GET /api/v1/notifications/preferences': () => json(200, { data: ALL_ON }),
      'PUT /api/v1/notifications/preferences': (init) => json(200, { data: JSON.parse(init.body) }),
    });
    render(
      <App
        router={createMemoryRouter(routes, { initialEntries: ['/app/account'] })}
        queryClient={createQueryClient()}
      />,
    );
    const reminders = await screen.findByRole('checkbox', { name: /Reminders/ });
    expect(reminders).toBeChecked();
    expect(screen.getByText(/Emergency guidance, urgent follow-ups/)).toBeInTheDocument();
    const save = screen.getByRole('button', { name: 'Save notification settings' });
    expect(save).toBeDisabled(); // nothing changed yet

    const ue = userEvent.setup();
    await ue.click(reminders);
    await ue.click(save);
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    await waitFor(() =>
      expect(calls.some((c) => c.key === 'PUT /api/v1/notifications/preferences')).toBe(true),
    );
    const put = calls.find((c) => c.key === 'PUT /api/v1/notifications/preferences');
    expect(JSON.parse(put.init.body)).toEqual({
      ...ALL_ON,
      email: { ...ALL_ON.email, reminders: false },
    });
  });
});
