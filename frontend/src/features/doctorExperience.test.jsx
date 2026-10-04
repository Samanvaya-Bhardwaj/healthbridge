import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { App } from '../app/App.jsx';
import { routes } from '../app/routes.jsx';
import { createQueryClient } from '../lib/queryClient.js';
import { setAccessToken } from '../lib/apiClient.js';
import {
  clearCookies,
  fakeApi,
  json,
  makeUser,
  sessionPayload,
  setCookie,
} from '../../tests/fakeApi.js';

const PATIENT = '0192b6f0-0000-7000-8000-0000000000a1';
const APPT = '0192b6f0-0000-7000-8000-0000000000e1';
const inMinutes = (m) => new Date(Date.now() + m * 60_000).toISOString();

function signedIn(routesMap) {
  setCookie('hb_csrf=csrf-1; path=/');
  const user = makeUser(['DOCTOR']);
  const calls = fakeApi({
    'POST /api/v1/auth/refresh': () => json(200, sessionPayload(user)),
    'GET /api/v1/auth/me': () => json(200, { data: user }),
    'GET /api/v1/notifications/unread-count': () => json(200, { data: { unreadCount: 0 } }),
    ...routesMap,
  });
  // Schedule queries carry dynamic dates: route them by prefix.
  const fetchMock = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    const key = `${init?.method ?? 'GET'} ${String(url).split('?')[0]}`;
    const handler = routesMap[`${key}?*`];
    if (handler) {
      calls.push({ key: `${key}?…`, init });
      return Promise.resolve(handler(init));
    }
    return fetchMock(url, init);
  };
  return calls;
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

describe('doctor: today', () => {
  it('features the next consultation with its state and starts it in one click', async () => {
    const appt = {
      id: APPT,
      patientId: PATIENT,
      reference: 'AB12CD34',
      status: 'confirmed',
      mode: 'online',
      feePaise: 20_000,
      startsAt: inMinutes(5),
      endsAt: inMinutes(20),
      patient: { id: PATIENT, fullName: 'Asha Rao', dateOfBirth: '1990-05-14' },
    };
    const calls = signedIn({
      'GET /api/v1/doctors/me/appointments?*': () => json(200, { data: [appt] }),
      'GET /api/v1/consents/received': () =>
        json(200, {
          data: [
            {
              id: 'c1',
              patientId: PATIENT,
              patientName: 'Asha Rao',
              status: 'active',
              scopes: ['patient_profile', 'medical_documents'],
              expiresAt: inMinutes(60 * 24),
            },
          ],
        }),
      'GET /api/v1/doctors/me/follow-ups?status=open': () => json(200, { data: [] }),
      'GET /api/v1/doctors/me/patients': () => json(200, { data: [] }),
      [`GET /api/v1/appointments/${APPT}/consultation/status`]: () =>
        json(200, {
          data: {
            party: 'doctor',
            consultation: null,
            waitingRoom: { open: true, patientPresent: true },
          },
        }),
      [`POST /api/v1/appointments/${APPT}/consultation/start`]: () =>
        json(200, { data: { status: 'live' } }),
    });
    const router = open('/app');
    const next = await screen.findByRole('region', { name: 'Next up' });
    expect(within(next).getByText('Asha Rao')).toBeInTheDocument();
    expect(within(next).getByText('Paid · ₹200.00')).toBeInTheDocument();
    expect(within(next).getByText('Records shared')).toBeInTheDocument();
    expect(await within(next).findByText('In the waiting room')).toBeInTheDocument();
    expect(within(next).getByRole('link', { name: 'AI brief' })).toHaveAttribute(
      'href',
      `/app/appointments/${APPT}/brief`,
    );
    await userEvent.click(within(next).getByRole('button', { name: 'Start consultation' }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/app/appointments/${APPT}/consultation`),
    );
    expect(calls.some((c) => c.key.endsWith('/consultation/start'))).toBe(true);
  });
});

describe('doctor: hours and time off', () => {
  const rule = {
    id: 'r1',
    mode: 'online',
    weekday: 1,
    startTime: '09:00',
    endTime: '12:00',
    slotMinutes: 15,
    validFrom: '2026-01-01',
    validUntil: null,
    feePaise: 0,
  };
  const base = {
    'GET /api/v1/doctors/me/availability': () => json(200, { data: [rule] }),
    'GET /api/v1/doctors/me/clinics': () => json(200, { data: [] }),
    'GET /api/v1/doctors/me/time-off': () => json(200, { data: [] }),
  };

  it('refuses overlapping hours before sending, and adds one rule per chosen day', async () => {
    const calls = signedIn({
      ...base,
      'GET /api/v1/doctors/me/appointments?*': () => json(200, { data: [] }),
      'POST /api/v1/doctors/me/availability': (init) => json(201, { data: JSON.parse(init.body) }),
    });
    open('/app/appointments?tab=availability');
    const user = userEvent.setup();
    // Monday 09:00–12:00 already exists: the default draft overlaps it.
    expect(
      await screen.findByText(/Overlaps your existing hours: Monday 09:00–12:00/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add hours' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Monday' }));
    await user.click(screen.getByRole('button', { name: 'Tuesday' }));
    await user.click(screen.getByRole('button', { name: 'Thursday' }));
    expect(screen.queryByText(/Overlaps your existing hours/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add hours' }));
    expect(await screen.findByText(/Hours added for Tuesday, Thursday/)).toBeInTheDocument();
    const posted = calls
      .filter((c) => c.key === 'POST /api/v1/doctors/me/availability')
      .map((c) => JSON.parse(c.init.body).weekday);
    expect(posted).toEqual([2, 4]);
  });

  it('shows booked appointments before adding time off over them', async () => {
    const start = new Date(Date.now() + 3 * 86_400_000);
    start.setHours(10, 0, 0, 0);
    const calls = signedIn({
      ...base,
      'GET /api/v1/doctors/me/appointments?*': () =>
        json(200, {
          data: [
            {
              id: 'a1',
              patientId: PATIENT,
              reference: 'ZZ11',
              status: 'confirmed',
              mode: 'online',
              startsAt: start.toISOString(),
              endsAt: new Date(start.getTime() + 15 * 60_000).toISOString(),
              patient: { fullName: 'Asha Rao' },
            },
          ],
        }),
      'POST /api/v1/doctors/me/time-off': () =>
        json(201, { data: { id: 't1', clashingAppointments: 1 } }),
    });
    open('/app/appointments?tab=availability');
    const user = userEvent.setup();
    const pad = (n) => String(n).padStart(2, '0');
    const day = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;
    await user.type(
      await screen.findByLabelText('From', { selector: '[type="datetime-local"]' }),
      `${day}T08:00`,
    );
    await user.type(
      screen.getByLabelText('Until', { selector: '[type="datetime-local"]' }),
      `${day}T18:00`,
    );
    const warning = (await screen.findByText('Booked in this period')).closest(
      '[role="alert"],div',
    );
    expect(warning).toHaveTextContent(/Asha Rao/);
    await user.click(screen.getByRole('button', { name: 'Add time off' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('does not cancel existing appointments');
    await user.click(within(dialog).getByRole('button', { name: 'Add time off anyway' }));
    await waitFor(() =>
      expect(calls.some((c) => c.key === 'POST /api/v1/doctors/me/time-off')).toBe(true),
    );
  });
});

describe('doctor: profile', () => {
  it('keeps every qualification when the profile is saved', async () => {
    const calls = signedIn({
      'GET /api/v1/doctors/me': () =>
        json(200, {
          data: {
            id: 'd1',
            professionalName: 'Dr. Synthetic',
            registrationNumber: 'REG-1',
            registrationCouncil: 'Council',
            registrationYear: 2010,
            primarySpecialization: 'General Medicine',
            qualifications: [
              { degree: 'MBBS', institution: 'College A', year: 2009 },
              { degree: 'MD', institution: 'College B', year: 2013 },
            ],
            yearsOfExperience: 12,
            languages: ['English'],
            verificationStatus: 'unverified',
            updatedAt: 'x',
          },
        }),
      'GET /api/v1/doctors/me/verification': () => json(200, { data: [] }),
      'PATCH /api/v1/doctors/me': (init) => json(200, { data: JSON.parse(init.body) }),
    });
    open('/app/doctor-profile');
    expect(await screen.findByText(/MD, College B \(2013\)\. These are kept/)).toBeInTheDocument();
    // Not verified: the preview says so instead of showing a verified mark.
    expect(screen.getByText('Registration not verified yet.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls.some((c) => c.key === 'PATCH /api/v1/doctors/me')).toBe(true));
    const body = JSON.parse(calls.find((c) => c.key === 'PATCH /api/v1/doctors/me').init.body);
    expect(body.qualifications).toEqual([
      { degree: 'MBBS', institution: 'College A', year: 2009 },
      { degree: 'MD', institution: 'College B', year: 2013 },
    ]);
  });
});
