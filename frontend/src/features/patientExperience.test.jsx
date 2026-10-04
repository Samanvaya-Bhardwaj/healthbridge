import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { App } from '../app/App.jsx';
import { routes } from '../app/routes.jsx';
import { createQueryClient } from '../lib/queryClient.js';
import { ApiError, setAccessToken } from '../lib/apiClient.js';
import { authErrorMessage } from './auth/errorMessages.js';
import {
  clearCookies,
  fakeApi,
  json,
  makeUser,
  problem,
  sessionPayload,
  setCookie,
} from '../../tests/fakeApi.js';

const PATIENT = '0192b6f0-0000-7000-8000-0000000000a1';
const DOCTOR = '0192b6f0-0000-7000-8000-0000000000d1';
const APPT = '0192b6f0-0000-7000-8000-0000000000e1';
const inDays = (days, h = 10) => {
  const d = new Date(Date.now() + days * 86_400_000);
  d.setHours(h, 0, 0, 0);
  return d.toISOString();
};

function signedIn(routesMap) {
  setCookie('hb_csrf=csrf-1; path=/');
  const user = makeUser(['PATIENT']);
  return fakeApi({
    'POST /api/v1/auth/refresh': () => json(200, sessionPayload(user)),
    'GET /api/v1/auth/me': () => json(200, { data: user }),
    'GET /api/v1/notifications/unread-count': () => json(200, { data: { unreadCount: 0 } }),
    ...routesMap,
  });
}
const open = (path) => {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={createQueryClient()} />);
  return router;
};

beforeEach(() => {
  clearCookies();
  setAccessToken(null);
});
afterEach(() => clearCookies());

describe('patient home', () => {
  it('a new patient sees the three first steps, starting with the profile', async () => {
    signedIn({ 'GET /api/v1/patients/me': () => problem(404, 'not_found') });
    open('/app');
    expect(
      await screen.findByRole('heading', { name: 'Get ready for your first consultation' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create profile' })).toHaveAttribute(
      'href',
      '/app/profile',
    );
  });

  it('puts the next appointment first and lists what needs the patient', async () => {
    signedIn({
      'GET /api/v1/patients/me': () => json(200, { data: { id: PATIENT } }),
      'GET /api/v1/care-relationships': () =>
        json(200, {
          data: [
            {
              id: 'r1',
              doctorId: DOCTOR,
              patientId: PATIENT,
              status: 'active',
              doctor: { professionalName: 'Dr. Meera Iyer', primarySpecialization: 'GP' },
            },
          ],
        }),
      'GET /api/v1/appointments?scope=upcoming': () =>
        json(200, {
          data: [
            {
              id: 'later',
              status: 'confirmed',
              mode: 'online',
              startsAt: inDays(5),
              doctor: { professionalName: 'Dr. Meera Iyer' },
            },
            {
              id: APPT,
              status: 'pending_payment',
              mode: 'in_clinic',
              feePaise: 50_000,
              startsAt: inDays(2),
              doctor: { professionalName: 'Dr. Meera Iyer' },
            },
          ],
        }),
      [`GET /api/v1/patients/${PATIENT}/follow-ups`]: () =>
        json(200, {
          data: [{ id: 'f1', status: 'awaiting_response', doctorName: 'Dr. Meera Iyer' }],
        }),
    });
    open('/app');
    const next = await screen.findByRole('region', { name: 'Your next appointment' });
    // The earliest appointment is the dominant card, with its one next action.
    expect(within(next).getByText(/^In 2 days/)).toBeInTheDocument();
    expect(within(next).getByRole('link', { name: 'Pay ₹500.00 to confirm' })).toHaveAttribute(
      'href',
      `/app/appointments/${APPT}/pay`,
    );
    const actions = screen.getByRole('region', { name: 'Needs your attention' });
    expect(within(actions).getByText('Dr. Meera Iyer asked how you are')).toBeInTheDocument();
    expect(
      within(actions).getByText('Pay ₹500.00 to confirm your appointment'),
    ).toBeInTheDocument();
  });
});

describe('appointment page', () => {
  const view = {
    party: 'patient',
    appointment: {
      id: APPT,
      status: 'confirmed',
      mode: 'online',
      startsAt: inDays(2),
      endsAt: inDays(2, 11),
      doctorName: 'Dr. Meera Iyer',
      clinicName: null,
      patientId: PATIENT,
      doctorId: DOCTOR,
    },
    consultation: null,
    waitingRoom: { open: false, opensAt: inDays(2), patientPresent: false },
    notes: [],
    prescriptions: [],
  };

  it('explains what happens next and shares records for this appointment only', async () => {
    let consents = [];
    const calls = signedIn({
      [`GET /api/v1/appointments/${APPT}/consultation`]: () => json(200, { data: view }),
      [`GET /api/v1/appointments/${APPT}`]: () =>
        json(200, {
          data: { id: APPT, reference: 'AB12CD34', feePaise: 0, reason: 'Synthetic cough' },
        }),
      [`GET /api/v1/consents?patientId=${PATIENT}`]: () => json(200, { data: consents }),
      'POST /api/v1/consents': (init) => {
        consents = [
          {
            id: 'c1',
            doctor: { id: DOCTOR, professionalName: 'Dr. Meera Iyer' },
            status: 'active',
            kind: 'appointment',
            scopes: JSON.parse(init.body).scopes,
            expiresAt: inDays(5),
          },
        ];
        return json(201, { data: consents[0] });
      },
    });
    open(`/app/appointments/${APPT}`);
    expect(await screen.findByRole('heading', { name: 'You’re booked' })).toBeInTheDocument();
    expect(await screen.findByText('Synthetic cough')).toBeInTheDocument();
    expect(screen.getByText('AB12CD34')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Share for this appointment' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Share your records with Dr. Meera Iyer?',
    });
    expect(dialog).toHaveTextContent(/ends automatically 72 hours after the appointment/);
    await user.click(within(dialog).getByRole('button', { name: 'Share for this appointment' }));
    await waitFor(() => expect(calls.some((c) => c.key === 'POST /api/v1/consents')).toBe(true));
    const body = JSON.parse(calls.find((c) => c.key === 'POST /api/v1/consents').init.body);
    expect(body).toEqual({
      patientId: PATIENT,
      doctorId: DOCTOR,
      kind: 'appointment',
      appointmentId: APPT,
      scopes: ['patient_profile', 'medical_documents'],
      purpose: 'consultation',
    });
    expect(await screen.findByText('Shared with Dr. Meera Iyer')).toBeInTheDocument();
  });

  it('shows the signed prescription first and folds the replaced version', async () => {
    const item = {
      position: 1,
      drugName: 'Paracetamol',
      dose: '1 tablet',
      frequency: 'twice a day',
      route: 'oral',
      duration: '3 days',
    };
    signedIn({
      [`GET /api/v1/appointments/${APPT}/consultation`]: () =>
        json(200, {
          data: {
            ...view,
            appointment: { ...view.appointment, status: 'completed' },
            consultation: { id: 'c1', status: 'ended', outcome: 'online_managed' },
            prescriptions: [
              { id: 'v1', reference: 'RX-1', version: 1, status: 'superseded', items: [item] },
              {
                id: 'v2',
                reference: 'RX-1',
                version: 2,
                status: 'signed',
                correctionReason: 'Dose clarified',
                items: [item],
                pdfReady: true,
              },
            ],
          },
        }),
    });
    open(`/app/appointments/${APPT}`);
    expect(await screen.findByText('Signed · valid')).toBeInTheDocument();
    expect(screen.getByText('Dose clarified')).toBeInTheDocument();
    expect(screen.getByText('Earlier version (1)')).toBeInTheDocument();
    expect(screen.getByText('Replaced by a correction')).not.toBeVisible();
  });
});

describe('error wording', () => {
  it('never shows status codes or generic server wording to people', () => {
    const err = (status, code, detail) => new ApiError({ status, code, title: code, detail });
    expect(authErrorMessage(err(404, 'not_found', 'No route for GET /x.'))).toBe(
      'We couldn’t find this. It may have been removed, or it isn’t shared with your account.',
    );
    expect(authErrorMessage(err(401, 'unauthenticated', 'Authentication is required.'))).toBe(
      'Your session has ended. Please sign in again.',
    );
    expect(authErrorMessage(err(403, 'forbidden', 'You do not have permission'))).toBe(
      'You can’t do this with your account.',
    );
    expect(authErrorMessage(err(500, 'internal', 'boom'))).toMatch(/temporarily unavailable/);
    // Messages written for people pass through unchanged.
    expect(
      authErrorMessage(err(409, 'follow_up_not_open', 'This check-in is no longer open.')),
    ).toBe('This check-in is no longer open.');
  });
});
