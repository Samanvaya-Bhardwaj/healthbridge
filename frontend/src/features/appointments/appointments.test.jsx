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
    const times = await screen.findAllByRole('button', { pressed: false, name: /[0-9]/ });
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

  it('a time taken meanwhile: explains, refreshes the free times and clears the choice', async () => {
    const [first, second] = [inTwoDays(10), inTwoDays(10, 15)].map((startsAt) => ({
      startsAt,
      endsAt: startsAt,
      mode: 'online',
      clinicId: null,
      feePaise: 0,
    }));
    signedIn(makeUser(['PATIENT']), {
      [`GET /api/v1/doctors/${DOCTOR}`]: () =>
        json(200, {
          data: { id: DOCTOR, professionalName: 'Dr. Meera Iyer', primarySpecialization: 'GP' },
        }),
      'POST /api/v1/appointments': () =>
        problem(409, 'slot_unavailable', 'This slot was just taken. Please choose another time.'),
    });
    let slotFetches = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (url, init) => {
      if (!String(url).startsWith(`/api/v1/doctors/${DOCTOR}/slots`))
        return originalFetch(url, init);
      slotFetches += 1;
      return Promise.resolve(json(200, { data: slotFetches === 1 ? [first, second] : [second] }));
    };

    renderAt(`/app/appointments/book?doctorId=${DOCTOR}&patientId=${PATIENT}`);
    const ue = userEvent.setup();
    const times = await screen.findAllByRole('button', { pressed: false, name: /[0-9]/ });
    expect(times).toHaveLength(2);
    await ue.click(times[0]);
    await ue.type(screen.getByLabelText('Reason for visit'), 'Follow-up on blood sugar');
    await ue.click(screen.getByRole('button', { name: 'Book appointment' }));

    expect(await screen.findByText(/This slot was just taken/)).toBeInTheDocument();
    await waitFor(() => expect(slotFetches).toBe(2));
    await waitFor(() =>
      expect(screen.getAllByRole('button', { pressed: false, name: /[0-9]/ })).toHaveLength(1),
    );
    expect(screen.getByText('Choose a time to continue.')).toBeInTheDocument();
  }, 15_000);
});

describe('booking a time chosen elsewhere (step 7)', () => {
  const slotsOf = (hours) =>
    hours.map((h) => ({
      startsAt: inTwoDays(h),
      endsAt: inTwoDays(h),
      mode: 'online',
      clinicId: null,
      feePaise: 0,
    }));
  const setup = () => {
    signedIn(makeUser(['PATIENT']), {
      [`GET /api/v1/doctors/${DOCTOR}`]: () =>
        json(200, {
          data: { id: DOCTOR, professionalName: 'Dr. Meera Iyer', primarySpecialization: 'GP' },
        }),
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (url, init) =>
      String(url).startsWith(`/api/v1/doctors/${DOCTOR}/slots`)
        ? Promise.resolve(json(200, { data: slotsOf([9, 11]) }))
        : originalFetch(url, init);
  };

  it('arrives with the chosen time selected; the patient still reviews and confirms', async () => {
    setup();
    const wanted = encodeURIComponent(inTwoDays(11));
    renderAt(
      `/app/appointments/book?doctorId=${DOCTOR}&patientId=${PATIENT}&mode=online&startsAt=${wanted}`,
    );
    const pressed = await screen.findAllByRole('button', { pressed: true, name: /[0-9]/ });
    expect(pressed).toHaveLength(1);
    expect(pressed[0].textContent).toMatch(/11/);
    // Nothing is booked yet: the confirm step still needs the reason and a click.
    expect(screen.getByRole('button', { name: 'Book appointment' })).toBeDisabled();
    expect(screen.queryByText(/no longer free/)).not.toBeInTheDocument();
  });

  it('says so when the chosen time has gone, and selects nothing', async () => {
    setup();
    const gone = encodeURIComponent(inTwoDays(15));
    renderAt(
      `/app/appointments/book?doctorId=${DOCTOR}&patientId=${PATIENT}&mode=online&startsAt=${gone}`,
    );
    expect(await screen.findByText(/The time you chose is no longer free/)).toBeInTheDocument();
    expect(screen.queryAllByRole('button', { pressed: true, name: /[0-9]/ })).toHaveLength(0);
  });
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
    const calls = signedIn(clinicAdmin, {
      // The clinic sees payment state only: no reason, no patient identity.
      'GET /api/v1/appointments/a9': () =>
        json(200, { data: { id: 'a9', paymentStatus: 'paid', feePaise: 50_000 } }),
      'POST /api/v1/appointments/a9/refunds': () =>
        json(202, {
          data: { id: 'rf1', amountPaise: 20_000, status: 'pending', reason: 'goodwill' },
        }),
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (url, init) =>
      String(url).startsWith(`/api/v1/clinics/${CLINIC}/appointments`)
        ? Promise.resolve(
            json(200, {
              data: [
                {
                  id: 'a9',
                  reference: 'ZZ99YY88',
                  doctorId: 'd1',
                  status: 'confirmed',
                  mode: 'in_clinic',
                  feePaise: 50_000,
                  startsAt: new Date(Date.now() + 30 * 60_000).toISOString(),
                  endsAt: new Date(Date.now() + 50 * 60_000).toISOString(),
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
    expect(within(row).getByText('Not arrived yet')).toBeInTheDocument();
    expect(await within(row).findByText('Paid ₹500.00')).toBeInTheDocument();
    // The role boundary is stated on the page.
    expect(screen.getByText(/Patient names, visit reasons, notes/)).toBeInTheDocument();

    // A partial goodwill refund, explained and confirmed before it is sent.
    const user = userEvent.setup();
    await user.click(within(row).getByRole('button', { name: 'Refund' }));
    const dialog = await screen.findByRole('dialog', { name: 'Refund Ref ZZ99YY88?' });
    await user.click(within(dialog).getByLabelText('A specific amount'));
    await user.type(within(dialog).getByLabelText('Amount (₹)'), '200');
    await user.click(within(dialog).getByRole('button', { name: 'Refund ₹200.00' }));
    expect(
      await within(dialog).findByText(/₹200.00 will go back to the patient/),
    ).toBeInTheDocument();
    const refund = calls.find((c) => c.key === 'POST /api/v1/appointments/a9/refunds');
    expect(JSON.parse(refund.init.body)).toEqual({ reasonCode: 'goodwill', amountPaise: 20_000 });
    expect(refund.init.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
  });
});
