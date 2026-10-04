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

const DOCTOR = '0192b6f0-0000-7000-8000-0000000000d1';
const PATIENT = '0192b6f0-0000-7000-8000-0000000000a1';
const CLINIC = '0192b6f0-0000-7000-8000-0000000000c1';
const inTwoDays = (h, m = 0) => {
  const d = new Date(Date.now() + 2 * 86_400_000);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};

function signedIn(user, routesMap) {
  setCookie('hb_csrf=csrf-1; path=/');
  return fakeApi({
    'POST /api/v1/auth/refresh': () => json(200, sessionPayload(user)),
    'GET /api/v1/auth/me': () => json(200, { data: user }),
    ...routesMap,
  });
}

function renderAt(path) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={createQueryClient()} />);
  return router;
}

const routeStartingWith = (calls, prefix) => calls.find((c) => c.key.startsWith(prefix));

beforeEach(() => {
  clearCookies();
  setAccessToken(null);
});
afterEach(() => clearCookies());

describe('booking', () => {
  it('lists slots by day, requires a reason, and books with an idempotency key', async () => {
    const slots = [inTwoDays(9), inTwoDays(9, 15)].map((startsAt) => ({
      startsAt,
      endsAt: startsAt,
      mode: 'online',
      clinicId: null,
      feePaise: 0,
    }));
    const routesMap = {
      [`GET /api/v1/doctors/${DOCTOR}`]: () =>
        json(200, {
          data: {
            id: DOCTOR,
            professionalName: 'Dr. Meera Iyer',
            primarySpecialization: 'General Medicine',
          },
        }),
      'POST /api/v1/appointments': () => json(201, { data: { id: 'a1', status: 'confirmed' } }),
      // After booking, the patient lands on the new appointment's page.
      'GET /api/v1/appointments/a1/consultation': () =>
        json(200, {
          data: {
            party: 'patient',
            appointment: {
              id: 'a1',
              status: 'confirmed',
              mode: 'online',
              startsAt: slots[1].startsAt,
              endsAt: slots[1].startsAt,
              doctorName: 'Dr. Meera Iyer',
              clinicName: null,
              patientId: PATIENT,
              doctorId: DOCTOR,
            },
            consultation: null,
            waitingRoom: { open: false, opensAt: slots[1].startsAt, patientPresent: false },
            notes: [],
            prescriptions: [],
          },
        }),
    };
    const calls = signedIn(makeUser(['PATIENT']), routesMap);
    // Slot query has dynamic dates: route by prefix.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (url, init) =>
      String(url).startsWith(`/api/v1/doctors/${DOCTOR}/slots`)
        ? Promise.resolve(json(200, { data: slots }))
        : originalFetch(url, init);

    const router = renderAt(`/app/appointments/book?doctorId=${DOCTOR}&patientId=${PATIENT}`);
    expect((await screen.findAllByText(/Dr. Meera Iyer/)).length).toBeGreaterThan(0);
    // One step at a time: the only mode with free times (online) is pre-selected.
    expect(screen.getByRole('radio', { name: /Online/ })).toBeChecked();
    expect(screen.getByRole('radiogroup', { name: 'Date' })).toBeInTheDocument();
    const ue = userEvent.setup();
    const times = await screen.findAllByRole('button', { pressed: false, name: /\d/ });
    await ue.click(times.find((b) => /9:15|09:15/.test(b.textContent)) ?? times[1]);
    const bookButton = screen.getByRole('button', { name: 'Book appointment' });
    expect(bookButton).toBeDisabled(); // reason required
    await ue.type(screen.getByLabelText('Reason for visit'), 'Follow-up on blood sugar');
    await ue.click(bookButton);

    await screen.findByText('Appointment booked.');
    expect(router.state.location.pathname).toBe('/app/appointments/a1');
    expect(screen.getByRole('heading', { name: 'You’re booked' })).toBeInTheDocument();
    const booking = routeStartingWith(calls, 'POST /api/v1/appointments');
    expect(booking.init.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(booking.init.body)).toMatchObject({
      patientId: PATIENT,
      doctorId: DOCTOR,
      mode: 'online',
      reason: 'Follow-up on blood sugar',
    });
  }, 15_000); // a five-step flow with typing; slow on loaded CI machines
});

describe('patient appointments', () => {
  it('shows upcoming appointments with details and a confirmed cancel', async () => {
    const calls = signedIn(makeUser(['PATIENT']), {
      'GET /api/v1/appointments?scope=upcoming': () =>
        json(200, {
          data: [
            {
              id: 'a1',
              doctorId: DOCTOR,
              reference: 'AB12CD34',
              status: 'confirmed',
              mode: 'online',
              startsAt: inTwoDays(10),
              doctor: { professionalName: 'Dr. Meera Iyer' },
            },
          ],
        }),
      'POST /api/v1/appointments/a1/cancel': () =>
        json(200, { data: { id: 'a1', status: 'cancelled' } }),
    });
    renderAt('/app/appointments');
    const item = (await screen.findByText(/Ref AB12CD34/)).closest('section');
    // Rescheduling and everything else about the visit live on its own page.
    expect(within(item).getByRole('link', { name: /^Details/ })).toHaveAttribute(
      'href',
      '/app/appointments/a1',
    );
    const user = userEvent.setup();
    // Cancelling asks first; "Keep it" closes without calling the API.
    await user.click(within(item).getByRole('button', { name: 'Cancel' }));
    let dialog = await screen.findByRole('dialog', { name: 'Cancel this appointment?' });
    expect(within(dialog).getByRole('button', { name: 'Cancel appointment' })).toHaveFocus();
    await user.click(within(dialog).getByRole('button', { name: 'Keep it' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(calls.some((c) => c.key === 'POST /api/v1/appointments/a1/cancel')).toBe(false);

    await user.click(within(item).getByRole('button', { name: 'Cancel' }));
    dialog = await screen.findByRole('dialog', { name: 'Cancel this appointment?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel appointment' }));
    await waitFor(() =>
      expect(calls.some((c) => c.key === 'POST /api/v1/appointments/a1/cancel')).toBe(true),
    );
    expect(
      JSON.parse(calls.find((c) => c.key === 'POST /api/v1/appointments/a1/cancel').init.body),
    ).toEqual({ reasonCode: 'patient_request' });
  });
});

describe('clinic schedule board', () => {
  it('shows references and doctors, never patient identity', async () => {
    const clinicAdmin = {
      ...makeUser([]),
      roles: ['CLINIC_ADMIN'],
      permissions: ['account:read'],
      clinicRoles: [{ clinicId: CLINIC, role: 'CLINIC_ADMIN' }],
      clinicPermissions: {
        [CLINIC]: ['appointments:read', 'appointments:manage', 'clinic:manage'],
      },
    };
    signedIn(clinicAdmin, {});
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (url, init) =>
      String(url).startsWith(`/api/v1/clinics/${CLINIC}/appointments`)
        ? Promise.resolve(
            json(200, {
              data: [
                {
                  id: 'a9',
                  reference: 'ZZ99YY88',
                  status: 'confirmed',
                  mode: 'in_clinic',
                  startsAt: inTwoDays(17),
                  doctor: { professionalName: 'Dr. Meera Iyer' },
                },
              ],
            }),
          )
        : originalFetch(url, init);
    renderAt('/app/appointments');
    const row = (await screen.findByText(/Ref ZZ99YY88/)).closest('li');
    expect(within(row).getByText(/Dr. Meera Iyer/)).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Check in' })).toBeInTheDocument();
    expect(screen.getByText(/visible only to the patient and their doctor/)).toBeInTheDocument();
  });
});
