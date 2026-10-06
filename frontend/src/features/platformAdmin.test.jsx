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

const admin = makeUser(['PLATFORM_ADMIN']);
function signedIn(routesMap) {
  setCookie('hb_csrf=csrf-1; path=/');
  return fakeApi({
    'POST /api/v1/auth/refresh': () => json(200, sessionPayload(admin)),
    'GET /api/v1/auth/me': () => json(200, { data: admin }),
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

describe('platform administrator', () => {
  it('overview shows pending work and job health, never clinical data', async () => {
    signedIn({
      'GET /api/v1/admin/doctor-verifications?status=pending': () =>
        json(200, { data: [{ id: 'a' }, { id: 'b' }] }),
      'GET /api/v1/admin/doctor-verifications?status=under_review': () =>
        json(200, { data: [{ id: 'c' }] }),
      'GET /api/v1/admin/operations/summary': () =>
        json(200, {
          data: {
            outbox: { dispatched: 10 },
            deadLetters: { open: 2 },
            queues: { notifications: { waiting: 0, active: 0, delayed: 0, failed: 0 } },
          },
        }),
      'GET /api/v1/admin/clinics?limit=100': () =>
        json(200, {
          data: [
            { id: 'k1', status: 'active' },
            { id: 'k2', status: 'inactive' },
          ],
        }),
    });
    open('/app');
    expect(
      await screen.findByText('Platform administrators do not have access to clinical records.'),
    ).toBeInTheDocument();
    const reviews = (await screen.findByText('Doctor applications to review')).closest('a');
    await waitFor(() => expect(reviews).toHaveTextContent('3'));
    expect(reviews).toHaveTextContent('1 in review · 2 waiting');
    expect(screen.getByText('Background jobs: needs attention')).toBeInTheDocument();
    expect(screen.getByText('1 inactive')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Disabled accounts/ })).toHaveAttribute(
      'href',
      '/app/admin/users?status=disabled',
    );
  });

  it('suspending a verified doctor needs a reason and an acknowledgement', async () => {
    const calls = signedIn({
      'GET /api/v1/admin/doctor-verifications?status=verified': () =>
        json(200, {
          data: [
            {
              id: 'v9',
              doctorId: 'd9',
              status: 'verified',
              registrationNumber: 'REG-1',
              registrationCouncil: 'Council',
              decisionReasonCode: 'credentials_confirmed',
              submittedAt: '2026-10-01T10:00:00Z',
              doctor: { professionalName: 'Dr. Synthetic', primarySpecialization: 'GP' },
            },
          ],
        }),
      'GET /api/v1/admin/doctor-verifications/v9': () =>
        json(200, {
          data: {
            id: 'v9',
            doctorProfile: {
              professionalName: 'Dr. Synthetic',
              primarySpecialization: 'GP',
              qualifications: [],
              yearsOfExperience: 3,
            },
          },
        }),
      'POST /api/v1/admin/doctors/d9/suspend': () =>
        json(200, { data: { id: 'd9', verificationStatus: 'suspended' } }),
    });
    open('/app/admin/verification');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: /Verified/ }));
    await user.click(await screen.findByRole('button', { name: 'View application' }));
    await user.click(await screen.findByRole('button', { name: 'Suspend doctor' }));
    const dialog = await screen.findByRole('dialog', { name: 'Suspend Dr. Synthetic?' });
    const confirm = within(dialog).getByRole('button', { name: 'Suspend doctor' });
    expect(confirm).toBeDisabled();
    await user.selectOptions(
      within(dialog).getByLabelText('Why are you suspending them?'),
      'registration_lapsed',
    );
    expect(confirm).toBeDisabled(); // acknowledgement still missing
    await user.click(within(dialog).getByLabelText(/stops new bookings/));
    await user.click(confirm);
    await waitFor(() =>
      expect(calls.some((c) => c.key === 'POST /api/v1/admin/doctors/d9/suspend')).toBe(true),
    );
    const body = JSON.parse(
      calls.find((c) => c.key === 'POST /api/v1/admin/doctors/d9/suspend').init.body,
    );
    expect(body).toEqual({ reasonCode: 'registration_lapsed' });
  });

  it('deactivating a clinic asks first and explains the effect', async () => {
    const calls = signedIn({
      'GET /api/v1/admin/clinics?limit=100': () =>
        json(200, {
          data: [
            {
              id: 'k1',
              name: 'Synthetic Clinic',
              status: 'active',
              city: 'Pune',
              createdAt: '2026-10-01T10:00:00Z',
            },
          ],
        }),
      'PATCH /api/v1/admin/clinics/k1/status': () =>
        json(200, { data: { id: 'k1', status: 'inactive' } }),
    });
    open('/app/admin/clinics');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Deactivate' }));
    const dialog = await screen.findByRole('dialog', { name: 'Deactivate Synthetic Clinic?' });
    expect(dialog).toHaveTextContent('Existing appointments are not cancelled');
    await user.click(within(dialog).getByRole('button', { name: 'Deactivate clinic' }));
    await waitFor(() =>
      expect(calls.some((c) => c.key === 'PATCH /api/v1/admin/clinics/k1/status')).toBe(true),
    );
  });

  it('explains that platform administrators have no clinical-record access', async () => {
    signedIn({});
    open('/app/records');
    expect(
      await screen.findByRole('heading', { name: 'You don’t have access to this page' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/^Platform administrators do not have access to clinical records\./),
    ).toBeInTheDocument();
  });
});
