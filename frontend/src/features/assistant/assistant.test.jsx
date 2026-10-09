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
  problem,
  sessionPayload,
  setCookie,
} from '../../../tests/fakeApi.js';

const PATIENT = '0192b6f0-0000-7000-8000-0000000000a7';
const SESSION = '0192b6f0-0000-7000-8000-0000000000b1';
const DOCTOR = '0192b6f0-0000-7000-8000-0000000000d1';
const NEW_DOCTOR = '0192b6f0-0000-7000-8000-0000000000d2';

const sessionView = (version = 1) => ({
  id: SESSION,
  patientId: PATIENT,
  actingFor: 'self',
  status: 'active',
  version,
  turns: version - 1,
  expiresAt: '2026-10-10T05:00:00Z',
});
const doctor = (id, name, careStatus) => ({
  type: 'doctor',
  careStatus,
  doctor: {
    id,
    professionalName: name,
    primarySpecialization: 'Dermatology',
    languages: ['English', 'Hindi'],
    yearsOfExperience: 9,
    clinics: [],
  },
});

function signedIn(routesMap) {
  setCookie('hb_csrf=csrf-1; path=/');
  const user = makeUser(['PATIENT']);
  return fakeApi({
    'POST /api/v1/auth/refresh': () => json(200, sessionPayload(user)),
    'GET /api/v1/auth/me': () => json(200, { data: user }),
    'GET /api/v1/notifications/unread-count': () => json(200, { data: { unreadCount: 0 } }),
    'GET /api/v1/patients/me': () => json(200, { data: { id: PATIENT, fullName: 'Asha Rao' } }),
    'GET /api/v1/patients/me/dependents': () => json(200, { data: [] }),
    'POST /api/v1/assistant/sessions': () => json(201, { data: sessionView(1) }),
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

describe('HealthBridge Assistant', () => {
  it('shows grounded suggestions as AI, separate from anything booked', async () => {
    const calls = signedIn({
      [`POST /api/v1/assistant/sessions/${SESSION}/messages`]: () =>
        json(200, {
          data: {
            session: sessionView(2),
            reply: {
              kind: 'answer',
              message: 'Here are 2 verified doctors who match.',
              source: 'ai_assistant',
              cards: [
                doctor(DOCTOR, 'Dr. Meera Iyer', 'active'),
                doctor(NEW_DOCTOR, 'Dr. New', 'none'),
                {
                  type: 'slot',
                  doctorId: DOCTOR,
                  doctorName: 'Dr. Meera Iyer',
                  startsAt: '2026-10-10T13:00:00Z',
                  mode: 'online',
                  feePaise: null,
                  patientId: PATIENT,
                  bookable: true,
                },
              ],
            },
            understood: {
              intent: 'find_doctor',
              criteria: { specialty: 'Dermatology', date: '2026-10-10', timeWindow: 'evening' },
            },
            degraded: false,
          },
        }),
    });
    open('/app/assistant');
    await userEvent.click(await screen.findByRole('button', { name: 'Find a doctor' }));

    expect(await screen.findByText('Here are 2 verified doctors who match.')).toBeInTheDocument();
    expect(screen.getByText('AI suggestion')).toBeInTheDocument();
    expect(screen.getByText('Suggested · not booked')).toBeInTheDocument();
    expect(screen.getByText(/What I understood:/).closest('p')).toHaveTextContent('Dermatology');
    expect(screen.getByText('In your care team')).toBeInTheDocument();
    expect(screen.getByText('Not in your care team yet')).toBeInTheDocument();
    // Booking stays the existing, confirmed flow.
    expect(screen.getByRole('link', { name: 'Book with Dr. Meera Iyer' })).toHaveAttribute(
      'href',
      `/app/appointments/book?doctorId=${DOCTOR}&patientId=${PATIENT}`,
    );
    expect(screen.getByRole('link', { name: /continue to booking/ })).toBeInTheDocument();

    const sent = calls.find((c) => c.key.endsWith('/messages'));
    expect(JSON.parse(sent.init.body)).toMatchObject({
      text: 'I would like to find a doctor',
      version: 1,
    });
  });

  it('shows emergency guidance and degraded answers distinctly', async () => {
    let n = 0;
    signedIn({
      [`POST /api/v1/assistant/sessions/${SESSION}/messages`]: () => {
        n += 1;
        return json(200, {
          data: {
            session: sessionView(n + 1),
            reply:
              n === 1
                ? {
                    kind: 'emergency',
                    message: 'If this might be an emergency, call 112 or 108 now.',
                    cards: [],
                  }
                : {
                    kind: 'fallback',
                    message: 'The assistant isn’t available right now.',
                    cards: [{ type: 'link', target: 'my_doctors' }],
                  },
            understood: { intent: null, criteria: {} },
            degraded: n !== 1,
          },
        });
      },
    });
    open('/app/assistant');
    const box = await screen.findByLabelText('Your message');
    await userEvent.type(box, 'I have chest pain{Enter}');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This might be an emergency');
    expect(within(alert).getByRole('link', { name: 'Call 112' })).toHaveAttribute(
      'href',
      'tel:112',
    );

    await userEvent.type(box, 'a doctor please{Enter}');
    expect(await screen.findByText('I couldn’t help with that just now')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open My Doctors' })).toBeInTheDocument();
  });

  it('offers a fresh conversation when the session has ended', async () => {
    signedIn({
      [`POST /api/v1/assistant/sessions/${SESSION}/messages`]: () =>
        problem(409, 'assistant_session_ended', 'This conversation has ended. Start a new one.'),
    });
    open('/app/assistant');
    await userEvent.type(await screen.findByLabelText('Your message'), 'hello{Enter}');
    expect(
      await screen.findByRole('button', { name: 'Start a new conversation' }),
    ).toBeInTheDocument();
  });

  it('falls back to My Doctors when the assistant cannot start', async () => {
    signedIn({
      'POST /api/v1/assistant/sessions': () => problem(503, 'service_unavailable', 'Down'),
    });
    open('/app/assistant');
    expect(await screen.findByText('The assistant isn’t available right now')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Find a doctor in My Doctors' })).toBeInTheDocument();
  });
});
