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
  problem,
  sessionPayload,
  setCookie,
} from '../../../tests/fakeApi.js';

const APPT = '0192b6f0-0000-7000-8000-0000000000e1';
const startsAt = new Date(Date.now() + 2 * 86_400_000).toISOString();

const appointment = (overrides = {}) => ({
  id: APPT,
  reference: '000000E1',
  patientId: '0192b6f0-0000-7000-8000-0000000000a1',
  doctorId: '0192b6f0-0000-7000-8000-0000000000d1',
  mode: 'online',
  status: 'pending_payment',
  paymentStatus: null,
  startsAt,
  endsAt: startsAt,
  feePaise: 50000,
  currency: 'INR',
  holdExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  doctor: { professionalName: 'Dr. Meera Iyer' },
  ...overrides,
});

const fakeCheckout = {
  data: {
    payment: { id: 'p1', status: 'pending', amountPaise: 50000, currency: 'INR' },
    holdExpiresAt: appointment().holdExpiresAt,
    checkout: {
      provider: 'fake',
      orderId: 'order_fake_1',
      amountPaise: 50000,
      currency: 'INR',
      simulated: true,
    },
  },
};

function signedIn(routesMap) {
  setCookie('hb_csrf=csrf-1; path=/');
  const user = makeUser(['PATIENT']);
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

beforeEach(() => {
  clearCookies();
  setAccessToken(null);
});
afterEach(() => clearCookies());

describe('payment', () => {
  it('shows the server amount, runs the test checkout and waits for server confirmation', async () => {
    let current = appointment();
    const calls = signedIn({
      [`GET /api/v1/appointments/${APPT}`]: () => json(200, { data: current }),
      [`POST /api/v1/appointments/${APPT}/payment`]: () => json(200, fakeCheckout),
      [`POST /api/v1/appointments/${APPT}/payment/simulate`]: () => {
        // The server confirms after its (simulated) verified webhook.
        current = appointment({ status: 'confirmed', paymentStatus: 'paid' });
        return json(200, { data: { received: true, status: 'processed' } });
      },
    });
    renderAt(`/app/appointments/${APPT}/pay`);
    expect(await screen.findByRole('heading', { name: 'Complete payment' })).toBeInTheDocument();
    expect(screen.getByText('₹500.00')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Pay ₹500.00' }));
    expect(await screen.findByText(/no real money moves/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Simulate successful payment' }));
    expect(await screen.findByText(/your appointment is confirmed/i)).toBeInTheDocument();

    // The browser never asserts payment success itself: no status-changing request
    // other than starting the checkout and the (server-side) simulation.
    const writes = calls.filter((c) => (c.init.method ?? 'GET') !== 'GET').map((c) => c.key);
    expect(writes).toEqual([
      'POST /api/v1/auth/refresh',
      `POST /api/v1/appointments/${APPT}/payment`,
      `POST /api/v1/appointments/${APPT}/payment/simulate`,
    ]);
    const checkoutCall = calls.find((c) => c.key === `POST /api/v1/appointments/${APPT}/payment`);
    expect(JSON.parse(checkoutCall.init.body)).toEqual({}); // no client-supplied amount
  });

  it('a failed payment offers a retry while the slot is held', async () => {
    let current = appointment();
    signedIn({
      [`GET /api/v1/appointments/${APPT}`]: () => json(200, { data: current }),
      [`POST /api/v1/appointments/${APPT}/payment`]: () => json(200, fakeCheckout),
      [`POST /api/v1/appointments/${APPT}/payment/simulate`]: () => {
        current = appointment({ paymentStatus: 'failed' });
        return json(200, { data: { received: true, status: 'processed' } });
      },
    });
    renderAt(`/app/appointments/${APPT}/pay`);
    await userEvent.click(await screen.findByRole('button', { name: 'Pay ₹500.00' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Simulate failed payment' }));
    expect(await screen.findByText(/did not go through/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('button', { name: 'Simulate successful payment' }),
    ).toBeInTheDocument();
  });

  it('explains a payment provider outage and an expired reservation', async () => {
    signedIn({
      [`GET /api/v1/appointments/${APPT}`]: () => json(200, { data: appointment() }),
      [`POST /api/v1/appointments/${APPT}/payment`]: () =>
        problem(
          503,
          'payment_provider_unavailable',
          'We could not reach the payment provider. Your booking is held; please try again.',
        ),
    });
    renderAt(`/app/appointments/${APPT}/pay`);
    await userEvent.click(await screen.findByRole('button', { name: 'Pay ₹500.00' }));
    expect(await screen.findByText(/booking is held/i)).toBeInTheDocument();
  });

  it('an expired booking cannot be paid for', async () => {
    signedIn({
      [`GET /api/v1/appointments/${APPT}`]: () =>
        json(200, { data: appointment({ status: 'expired', paymentStatus: 'cancelled' }) }),
    });
    renderAt(`/app/appointments/${APPT}/pay`);
    expect(await screen.findByText(/slot was released/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Pay/ })).not.toBeInTheDocument();
  });

  it('the appointments list offers "Pay" for held bookings and shows payment status', async () => {
    signedIn({
      'GET /api/v1/appointments?scope=upcoming': () =>
        json(200, {
          data: [
            appointment(),
            appointment({
              id: `${APPT.slice(0, -1)}2`,
              reference: '000000E2',
              status: 'confirmed',
              paymentStatus: 'paid',
            }),
          ],
        }),
    });
    renderAt('/app/appointments');
    const pay = await screen.findByRole('link', { name: 'Pay ₹500.00' });
    expect(pay).toHaveAttribute('href', `/app/appointments/${APPT}/pay`);
    expect(screen.getByText('Paid')).toBeInTheDocument();
  });
});
