import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
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

const PATIENT = '0192b6f0-0000-7000-8000-0000000000a7';
const FU = '0192b6f0-0000-7000-8000-0000000000f1';
const GUIDANCE = {
  title: 'Seek emergency care now',
  lines: ['Call 112 (India emergency number) or 108 for an ambulance.'],
};
const followUp = (overrides = {}) => ({
  id: FU,
  patientId: PATIENT,
  patientName: 'Asha Rao',
  doctorName: 'Dr. Synthetic',
  dueOn: '2026-10-12',
  status: 'awaiting_response',
  escalation: { level: 'none', reasons: [] },
  response: null,
  summary: null,
  ...overrides,
});

function signedIn(roles, routesMap) {
  setCookie('hb_csrf=csrf-1; path=/');
  const user = makeUser(roles);
  return fakeApi({
    'POST /api/v1/auth/refresh': () => json(200, sessionPayload(user)),
    'GET /api/v1/auth/me': () => json(200, { data: user }),
    'GET /api/v1/notifications/unread-count': () => json(200, { data: { unreadCount: 2 } }),
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
afterEach(() => clearCookies());

describe('follow-ups', () => {
  it('patient answers a check-in with a warning sign and sees emergency guidance', async () => {
    let body = null;
    const calls = signedIn(['PATIENT'], {
      'GET /api/v1/patients/me': () => json(200, { data: { id: PATIENT } }),
      'GET /api/v1/patients/me/dependents': () => json(200, { data: [] }),
      [`GET /api/v1/patients/${PATIENT}/follow-ups`]: () =>
        json(200, {
          data: [
            followUp(
              body ? { status: 'urgent', escalation: { level: 'urgent', reasons: [] } } : {},
            ),
          ],
        }),
      [`POST /api/v1/follow-ups/${FU}/responses`]: (init) => {
        body = JSON.parse(init.body);
        return json(201, {
          data: { ...followUp({ status: 'urgent' }), emergencyGuidance: GUIDANCE },
        });
      },
    });
    open('/app/follow-ups');
    expect(await screen.findByText(/Check-in from Dr. Synthetic/)).toBeInTheDocument();
    const send = screen.getByRole('button', { name: 'Send check-in' });
    expect(send).toBeDisabled();
    await userEvent.click(screen.getByLabelText('Worse'));
    await userEvent.click(screen.getByLabelText('Difficulty breathing'));
    await userEvent.click(send);
    expect(await screen.findByRole('alert')).toHaveTextContent('Seek emergency care now');
    expect(body).toEqual({ overall: 'worse', redFlags: ['breathing_difficulty'], note: '' });
    expect(calls.some((c) => c.key === `POST /api/v1/follow-ups/${FU}/responses`)).toBe(true);
  });

  it('doctor reviews an urgent check-in with the labelled AI summary', async () => {
    signedIn(['DOCTOR'], {
      'GET /api/v1/doctors/me/patients': () => json(200, { data: [] }),
      'GET /api/v1/doctors/me/follow-ups?status=open': () =>
        json(200, {
          data: [followUp({ status: 'urgent', escalation: { level: 'urgent', reasons: [] } })],
        }),
      [`GET /api/v1/follow-ups/${FU}`]: () =>
        json(200, {
          data: followUp({
            status: 'urgent',
            escalation: { level: 'urgent', reasons: [] },
            response: {
              overall: 'worse',
              redFlags: [{ code: 'breathing_difficulty', label: 'Difficulty breathing' }],
              note: 'Synthetic note',
            },
            summary: {
              status: 'ready',
              source: 'ai_generated',
              sentences: [{ text: 'The patient feels worse.', citations: [{ label: 'F1' }] }],
            },
          }),
        }),
    });
    open('/app/follow-ups');
    expect(await screen.findByText(/Asha Rao · due 2026-10-12/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(await screen.findByText('Warning signs: Difficulty breathing')).toBeInTheDocument();
    expect(screen.getByText('AI-generated')).toBeInTheDocument();
    expect(screen.getByText('The patient feels worse.')).toBeInTheDocument();
  });
});

describe('inbox', () => {
  it('shows the unread count in the header and marks notifications read', async () => {
    let read = false;
    signedIn(['PATIENT'], {
      'GET /api/v1/notifications?limit=20': () =>
        json(200, {
          data: [
            {
              id: 'n1',
              template: 'follow_up_due',
              title: 'Follow-up check-in from Dr. Synthetic',
              body: 'Dr. Synthetic would like to know how you are doing.',
              link: '/app/follow-ups',
              priority: 'normal',
              createdAt: '2026-10-03T04:00:00Z',
              readAt: read ? '2026-10-03T05:00:00Z' : null,
            },
          ],
          meta: { unreadCount: read ? 0 : 1, nextCursor: null },
        }),
      'POST /api/v1/notifications/n1/read': () => {
        read = true;
        return json(200, { data: {} });
      },
    });
    open('/app/notifications');
    expect(
      await screen.findByRole('link', { name: 'Notifications, 2 unread' }),
    ).toBeInTheDocument();
    const item = (await screen.findByText('Follow-up check-in from Dr. Synthetic')).closest('li');
    await userEvent.click(within(item).getByRole('button', { name: 'Mark read' }));
    expect(await screen.findByText('You are all caught up.')).toBeInTheDocument();
  });
});
