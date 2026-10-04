import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
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

const APPT = '0192b6f0-0000-7000-8000-0000000000e1';
const PATIENT = '0192b6f0-0000-7000-8000-0000000000a1';
const FALLBACK = 'Insufficient information. Please consult the doctor.';

function signedIn(routesMap) {
  setCookie('hb_csrf=csrf-1; path=/');
  const user = makeUser(['DOCTOR']);
  return fakeApi({
    'POST /api/v1/auth/refresh': () => json(200, sessionPayload(user)),
    'GET /api/v1/auth/me': () => json(200, { data: user }),
    ...routesMap,
  });
}

beforeEach(() => {
  clearCookies();
  setAccessToken(null);
});
afterEach(() => clearCookies());

describe('doctor AI assistance', () => {
  it('shows a cited brief with an AI notice and records feedback', async () => {
    let rating = null;
    const calls = signedIn({
      [`POST /api/v1/appointments/${APPT}/brief`]: () =>
        json(200, {
          data: {
            id: 'b1',
            status: 'ready',
            sections: [
              {
                heading: 'Recent verified lab values',
                sentences: [
                  {
                    text: 'WBC: 11.9 10^3/uL (high), verified by a doctor',
                    citations: [
                      { label: 'F1', type: 'lab_result', title: 'Verified lab value: WBC' },
                    ],
                  },
                ],
              },
            ],
            feedback: rating ? { rating } : null,
          },
        }),
      'POST /api/v1/briefs/b1/feedback': (init) => {
        rating = JSON.parse(init.body).rating;
        return json(200, { data: { rating } });
      },
    });
    const router = createMemoryRouter(routes, {
      initialEntries: [`/app/appointments/${APPT}/brief`],
    });
    render(<App router={router} queryClient={createQueryClient()} />);
    expect(await screen.findByText('Recent verified lab values')).toBeInTheDocument();
    expect(screen.getByText('F1 · Verified lab value: WBC')).toBeInTheDocument();
    expect(screen.getByText('AI-generated · not a clinical opinion')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Yes' }));
    expect(calls.some((c) => c.key === 'POST /api/v1/briefs/b1/feedback')).toBe(true);
  });

  it('shows the exact fallback when the records do not answer the question', async () => {
    signedIn({
      [`GET /api/v1/patients/${PATIENT}/documents`]: () => json(200, { data: [] }),
      [`GET /api/v1/patients/${PATIENT}/lab-results`]: () => json(200, { data: [] }),
      [`GET /api/v1/patients/${PATIENT}/timeline?limit=30`]: () =>
        json(200, { data: [], meta: { nextCursor: null } }),
      [`POST /api/v1/patients/${PATIENT}/record-questions`]: () =>
        json(200, {
          data: { status: 'insufficient_information', answer: FALLBACK, sentences: [] },
        }),
    });
    const router = createMemoryRouter(routes, {
      initialEntries: [`/app/medical-records/${PATIENT}`],
    });
    render(<App router={router} queryClient={createQueryClient()} />);
    // Asking AI is its own tab, separate from the source records.
    await userEvent.click(await screen.findByRole('tab', { name: 'Ask AI' }));
    await userEvent.type(await screen.findByLabelText(/Ask about these records/), 'Any MRI?');
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect(await screen.findByText(FALLBACK)).toBeInTheDocument();
  });
});
