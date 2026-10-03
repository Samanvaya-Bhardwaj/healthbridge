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
  sessionPayload,
  setCookie,
} from '../../../tests/fakeApi.js';

const APPT = '0192b6f0-0000-7000-8000-0000000000e9';
const BASE = `/api/v1/appointments/${APPT}/consultation`;
const appointment = {
  id: APPT,
  status: 'confirmed',
  mode: 'online',
  startsAt: '2026-10-05T04:00:00Z',
  endsAt: '2026-10-05T04:15:00Z',
  doctorName: 'Dr. Synthetic',
  clinicName: null,
  patientId: 'p1',
  doctorId: 'd1',
};
const waitingRoom = { open: true, opensAt: '2026-10-05T03:45:00Z', patientPresent: true };
const GUIDANCE = {
  title: 'Seek emergency care now',
  lines: ['Call 112 (India emergency number) or 108 for an ambulance.'],
};
const RX = {
  id: 'rx1',
  reference: 'RX-ABCDEFGHJK',
  version: 1,
  status: 'signed',
  items: [
    {
      position: 1,
      drugName: 'Paracetamol',
      strength: '500 mg',
      form: 'tablet',
      dose: '1 tablet',
      frequency: 'every 6 hours',
      route: 'oral',
      duration: '3 days',
      instructions: '',
    },
  ],
  advice: '',
  pdfReady: true,
};

function signedIn(roles, routesMap) {
  setCookie('hb_csrf=csrf-1; path=/');
  const user = makeUser(roles);
  return fakeApi({
    'POST /api/v1/auth/refresh': () => json(200, sessionPayload(user)),
    'GET /api/v1/auth/me': () => json(200, { data: user }),
    ...routesMap,
  });
}

const open = () => {
  const router = createMemoryRouter(routes, {
    initialEntries: [`/app/appointments/${APPT}/consultation`],
  });
  render(<App router={router} queryClient={createQueryClient()} />);
};

beforeEach(() => {
  clearCookies();
  setAccessToken(null);
});
afterEach(() => clearCookies());

describe('consultation room', () => {
  it('doctor sees the waiting patient and starts the consultation', async () => {
    let started = false;
    const view = () => ({
      party: 'doctor',
      appointment: { ...appointment, status: started ? 'in_consultation' : 'confirmed' },
      consultation: started
        ? { id: 'c1', status: 'live', mode: 'online', video: true, outcome: null }
        : null,
      waitingRoom,
      notes: [],
      prescriptions: [],
      emergencyGuidance: null,
    });
    const calls = signedIn(['DOCTOR'], {
      [`GET ${BASE}`]: () => json(200, { data: view() }),
      [`GET ${BASE}/status`]: () =>
        json(200, {
          data: {
            party: 'doctor',
            consultation: started ? { id: 'c1', status: 'live', outcome: null } : null,
            waitingRoom,
            emergencyGuidance: null,
          },
        }),
      [`POST ${BASE}/start`]: () => {
        started = true;
        return json(200, { data: view() });
      },
    });
    open();
    expect(await screen.findByText('The patient is in the waiting room.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Start consultation' }));
    expect(calls.some((c) => c.key === `POST ${BASE}/start`)).toBe(true);
    expect(await screen.findByText('Consultation note (SOAP)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Join video' })).toBeInTheDocument();
    // Outcome C needs explicit confirmation.
    await userEvent.click(screen.getByLabelText('Emergency care advised'));
    const end = screen.getByRole('button', { name: 'Record outcome and end consultation' });
    expect(end).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox'));
    expect(end).toBeEnabled();
  });

  it('signing a note asks for confirmation; Escape cancels, confirming signs', async () => {
    const live = {
      party: 'doctor',
      appointment: { ...appointment, status: 'in_consultation' },
      consultation: { id: 'c1', status: 'live', mode: 'online', video: true, outcome: null },
      waitingRoom,
      notes: [],
      prescriptions: [],
      emergencyGuidance: null,
    };
    const calls = signedIn(['DOCTOR'], {
      [`GET ${BASE}`]: () => json(200, { data: live }),
      [`GET ${BASE}/status`]: () =>
        json(200, {
          data: {
            party: 'doctor',
            consultation: { id: 'c1', status: 'live', outcome: null },
            waitingRoom,
            emergencyGuidance: null,
          },
        }),
      [`PUT ${BASE}/note`]: () => json(200, { data: { id: 'n1', status: 'draft' } }),
      [`POST ${BASE}/note/sign`]: () => json(200, { data: { id: 'n1', status: 'signed' } }),
    });
    open();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Subjective'), 'Synthetic: sore throat');
    const signButton = screen.getByRole('button', { name: 'Sign note' });
    await user.click(signButton);
    const dialog = await screen.findByRole('dialog', { name: 'Sign this clinical note?' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(signButton).toHaveFocus(); // focus returns to the opener
    expect(calls.some((c) => c.key === `POST ${BASE}/note/sign`)).toBe(false);

    await user.click(signButton);
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Sign note' }),
    );
    await waitFor(() => expect(calls.some((c) => c.key === `POST ${BASE}/note/sign`)).toBe(true));
  });

  it('patient sees fixed emergency guidance after outcome C', async () => {
    const ended = { id: 'c1', status: 'ended', mode: 'online', video: true };
    signedIn(['PATIENT'], {
      [`GET ${BASE}`]: () =>
        json(200, {
          data: {
            party: 'patient',
            appointment: { ...appointment, status: 'completed' },
            consultation: { ...ended, outcome: 'emergency_escalation', outcomeDetail: {} },
            waitingRoom: { ...waitingRoom, open: false },
            notes: [],
            prescriptions: [],
            emergencyGuidance: GUIDANCE,
          },
        }),
      [`GET ${BASE}/status`]: () =>
        json(200, {
          data: {
            party: 'patient',
            consultation: { id: 'c1', status: 'ended', outcome: 'emergency_escalation' },
            waitingRoom: { ...waitingRoom, open: false },
            emergencyGuidance: GUIDANCE,
          },
        }),
    });
    open();
    expect(await screen.findByRole('alert')).toHaveTextContent('Seek emergency care now');
    expect(screen.getByRole('link', { name: 'Call 112' })).toHaveAttribute('href', 'tel:112');
  });

  it('patient sees the visit summary, the signed prescription and the in-person request', async () => {
    signedIn(['PATIENT'], {
      [`GET ${BASE}`]: () =>
        json(200, {
          data: {
            party: 'patient',
            appointment: { ...appointment, status: 'completed' },
            consultation: {
              id: 'c1',
              status: 'ended',
              mode: 'online',
              video: true,
              outcome: 'physical_visit_required',
              outcomeDetail: { visitNote: 'Synthetic: examination needed.' },
            },
            waitingRoom: { ...waitingRoom, open: false },
            notes: [
              {
                id: 'n1',
                version: 1,
                status: 'signed',
                note: {
                  subjective: 'Synthetic sore throat',
                  objective: '',
                  assessment: '',
                  plan: '',
                },
                signedAt: '2026-10-05T04:10:00Z',
              },
            ],
            prescriptions: [RX],
            emergencyGuidance: null,
          },
        }),
      [`GET ${BASE}/status`]: () =>
        json(200, {
          data: {
            party: 'patient',
            consultation: { id: 'c1', status: 'ended', outcome: 'physical_visit_required' },
            waitingRoom: { ...waitingRoom, open: false },
            emergencyGuidance: null,
          },
        }),
    });
    open();
    expect(
      await screen.findByText('Your doctor would like to see you in person'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Book an in-clinic visit' })).toHaveAttribute(
      'href',
      '/app/appointments/book?doctorId=d1&mode=in_clinic',
    );
    expect(screen.getByText('Synthetic sore throat')).toBeInTheDocument();
    expect(screen.getByText(/Paracetamol/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download PDF' })).toBeEnabled();
  });
});
