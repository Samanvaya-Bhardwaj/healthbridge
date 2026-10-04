import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
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
import { attentionItems } from './clinics/clinicWork.js';

const CLINIC = '0192b6f0-0000-7000-8000-0000000000c1';
const clinicAdmin = {
  ...makeUser([]),
  roles: ['CLINIC_ADMIN'],
  permissions: ['account:read'],
  clinicRoles: [{ clinicId: CLINIC, role: 'CLINIC_ADMIN' }],
  clinicPermissions: {
    [CLINIC]: ['appointments:read', 'appointments:manage', 'clinic:manage', 'payments:refund'],
  },
};

beforeEach(() => {
  clearCookies();
  setAccessToken(null);
});
afterEach(() => clearCookies());

describe('clinic administrator', () => {
  it('explains the role boundary instead of a bare refusal on clinical pages', async () => {
    setCookie('hb_csrf=csrf-1; path=/');
    fakeApi({
      'POST /api/v1/auth/refresh': () => json(200, sessionPayload(clinicAdmin)),
      'GET /api/v1/auth/me': () => json(200, { data: clinicAdmin }),
    });
    const router = createMemoryRouter(routes, {
      initialEntries: ['/app/medical-records/0192b6f0-0000-7000-8000-0000000000a1'],
    });
    render(<App router={router} queryClient={createQueryClient()} />);
    expect(
      await screen.findByRole('heading', { name: 'You don’t have access to this page' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Clinic operations only')).toBeInTheDocument();
    expect(screen.getByText(/visible only to the patient and the doctors/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to clinic overview' })).toHaveAttribute(
      'href',
      '/app',
    );
  });

  it('flags late arrivals, payment holds and double bookings as operational issues', () => {
    const now = Date.parse('2026-10-05T10:00:00Z');
    const at = (min) => new Date(now + min * 60_000).toISOString();
    const base = { doctor: { professionalName: 'Dr. A' } };
    const items = attentionItems(
      [
        {
          ...base,
          id: '1',
          reference: 'LATE',
          doctorId: 'd1',
          mode: 'in_clinic',
          status: 'confirmed',
          startsAt: at(-30),
          endsAt: at(-10),
        },
        {
          ...base,
          id: '2',
          reference: 'HOLD',
          doctorId: 'd2',
          mode: 'in_clinic',
          status: 'pending_payment',
          startsAt: at(60),
          endsAt: at(80),
        },
        {
          ...base,
          id: '3',
          reference: 'X1',
          doctorId: 'd3',
          mode: 'online',
          status: 'confirmed',
          startsAt: at(120),
          endsAt: at(140),
        },
        {
          ...base,
          id: '4',
          reference: 'X2',
          doctorId: 'd3',
          mode: 'online',
          status: 'confirmed',
          startsAt: at(130),
          endsAt: at(150),
        },
      ],
      now,
    );
    expect(items.map((i) => i.title)).toEqual([
      'Ref LATE not checked in',
      'Ref HOLD awaiting payment',
      'Dr. A is double-booked',
    ]);
  });
});
