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
  problem,
  sessionPayload,
  setCookie,
} from '../../tests/fakeApi.js';

const CLINIC = '0192b6f0-0000-7000-8000-0000000000c1';

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

beforeEach(() => {
  clearCookies();
  setAccessToken(null);
});
afterEach(() => clearCookies());

describe('patient profile', () => {
  it('offers profile creation when none exists and submits only editable fields', async () => {
    const calls = signedIn(makeUser(['PATIENT']), {
      'GET /api/v1/patients/me': () => problem(404, 'not_found'),
      'POST /api/v1/patients/me': () => json(201, { data: { id: 'p1', fullName: 'Asha Rao' } }),
    });
    renderAt('/app/profile');
    expect(
      await screen.findByRole('heading', { name: 'Create your health profile' }),
    ).toBeInTheDocument();
    const ue = userEvent.setup();
    // The account name is offered as a starting point.
    expect(screen.getByLabelText('Full name')).toHaveValue('Asha Rao');
    await ue.type(screen.getByLabelText('Date of birth'), '1990-05-14');
    await ue.click(screen.getByRole('button', { name: 'Create profile' }));
    await screen.findByText('Saved.');
    const body = JSON.parse(calls.find((c) => c.key === 'POST /api/v1/patients/me').init.body);
    expect(body).toMatchObject({ fullName: 'Asha Rao', dateOfBirth: '1990-05-14' });
    expect(body).not.toHaveProperty('id');
  });

  it('requires both emergency contact name and phone', async () => {
    signedIn(makeUser(['PATIENT']), { 'GET /api/v1/patients/me': () => problem(404, 'not_found') });
    renderAt('/app/profile');
    const ue = userEvent.setup();
    await screen.findByRole('heading', { name: 'Create your health profile' });
    await ue.type(screen.getByLabelText('Date of birth'), '1990-05-14');
    await ue.type(screen.getByLabelText('Name'), 'Ravi');
    await ue.click(screen.getByRole('button', { name: 'Create profile' }));
    expect(await screen.findByText(/both a name and a phone number/)).toBeInTheDocument();
  });
});

describe('my doctors', () => {
  it('lists the care team with state-appropriate actions and lets the patient accept an invitation', async () => {
    const calls = signedIn(makeUser(['PATIENT']), {
      'GET /api/v1/patients/me': () => json(200, { data: { id: 'p1', fullName: 'Asha Rao' } }),
      'GET /api/v1/care-relationships': () =>
        json(200, {
          data: [
            {
              id: 'r1',
              doctorId: 'd1',
              status: 'invited',
              doctor: {
                professionalName: 'Dr. Meera Iyer',
                primarySpecialization: 'General Medicine',
              },
            },
            {
              id: 'r2',
              doctorId: 'd2',
              status: 'active',
              doctor: { professionalName: 'Dr. Rahul Menon', primarySpecialization: 'Paediatrics' },
            },
          ],
        }),
      'GET /api/v1/doctors?limit=20': () => json(200, { data: [], meta: {} }),
      'POST /api/v1/care-relationships/r1/accept': () =>
        json(200, { data: { id: 'r1', status: 'active' } }),
    });
    renderAt('/app/doctors');
    const invited = (await screen.findByText('Dr. Meera Iyer')).closest('li');
    expect(within(invited).getByText('Invitation')).toBeInTheDocument();
    expect(within(invited).getByText(/Nothing is shared unless you accept/)).toBeInTheDocument();
    const active = screen.getByText('Dr. Rahul Menon').closest('li');
    expect(within(active).getByRole('button', { name: 'Pause' })).toBeInTheDocument();

    await userEvent.setup().click(within(invited).getByRole('button', { name: 'Accept' }));
    expect(calls.some((c) => c.key === 'POST /api/v1/care-relationships/r1/accept')).toBe(true);
  });
});

describe('doctor workspace', () => {
  it('shows verification status and lets an applicant submit', async () => {
    const calls = signedIn(makeUser(['PATIENT']), {
      'GET /api/v1/doctors/me': () =>
        json(200, {
          data: {
            id: 'd1',
            professionalName: 'Dr. Applicant',
            registrationNumber: 'REG-1',
            registrationCouncil: 'Council',
            registrationYear: 2018,
            primarySpecialization: 'Dermatology',
            qualifications: [{ degree: 'MBBS', institution: 'College', year: 2017 }],
            yearsOfExperience: 5,
            languages: ['English'],
            verificationStatus: 'unverified',
            updatedAt: 'x',
          },
        }),
      'GET /api/v1/doctors/me/verification': () => json(200, { data: [] }),
      'POST /api/v1/doctors/me/verification': () =>
        json(201, { data: { id: 'v1', status: 'pending' } }),
    });
    renderAt('/app/doctor-profile');
    expect(await screen.findByText(/Submit your registration details/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Submit for verification' }));
    expect(calls.some((c) => c.key === 'POST /api/v1/doctors/me/verification')).toBe(true);
  });

  it('a doctor sees pending requests (shared name only) and active patients', async () => {
    signedIn(makeUser(['DOCTOR', 'PATIENT']), {
      'GET /api/v1/doctors/me/patients': () =>
        json(200, {
          data: [
            { id: 'r1', status: 'pending', patient: { displayName: 'Vikram' } },
            {
              id: 'r2',
              status: 'active',
              patient: { id: 'p2', fullName: 'Asha Rao', dateOfBirth: '1990-05-14' },
            },
          ],
        }),
    });
    renderAt('/app/patients');
    const request = (await screen.findByText('Vikram')).closest('li');
    expect(within(request).getByRole('button', { name: 'Accept' })).toBeInTheDocument();
    const myPatients = screen
      .getByRole('heading', { name: /Care team patients/ })
      .closest('section');
    expect(myPatients).toHaveTextContent('Asha Rao');
  });
});

describe('administration', () => {
  it('platform admin reviews the verification queue', async () => {
    const admin = makeUser(['PLATFORM_ADMIN']);
    const calls = signedIn(admin, {
      'GET /api/v1/admin/doctor-verifications?status=under_review': () =>
        json(200, {
          data: [
            {
              id: 'v1',
              status: 'under_review',
              registrationNumber: 'REG-9',
              registrationCouncil: 'Council',
              registrationYear: 2019,
              submittedAt: '2026-10-01T10:00:00Z',
              doctor: { professionalName: 'Dr. Farah Khan', primarySpecialization: 'Dermatology' },
            },
          ],
        }),
      // The full application (an audited read) opens with the case.
      'GET /api/v1/admin/doctor-verifications/v1': () =>
        json(200, {
          data: {
            id: 'v1',
            doctorProfile: {
              professionalName: 'Dr. Farah Khan',
              primarySpecialization: 'Dermatology',
              additionalSpecializations: [],
              qualifications: [{ degree: 'MBBS', institution: 'Synthetic College', year: 2015 }],
              yearsOfExperience: 6,
              languages: ['English'],
              bio: null,
              createdAt: '2026-10-01T09:00:00Z',
            },
          },
        }),
      'POST /api/v1/admin/doctor-verifications/v1/decision': () =>
        json(200, { data: { id: 'v1', status: 'verified' } }),
    });
    renderAt('/app/admin/verification');
    expect((await screen.findAllByText('Dr. Farah Khan')).length).toBeGreaterThan(0);
    expect(await screen.findByText('MBBS, Synthetic College (2015)')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Verify doctor' }));
    // Verifying asks the admin to confirm they checked the register.
    const dialog = await screen.findByRole('dialog', { name: 'Verify Dr. Farah Khan?' });
    const confirm = within(dialog).getByRole('button', { name: 'Verify doctor' });
    expect(confirm).toBeDisabled();
    await user.click(within(dialog).getByLabelText(/I checked registration REG-9 with Council/));
    await user.click(confirm);
    await waitFor(() =>
      expect(
        calls.some((c) => c.key === 'POST /api/v1/admin/doctor-verifications/v1/decision'),
      ).toBe(true),
    );
    const decision = calls.find(
      (c) => c.key === 'POST /api/v1/admin/doctor-verifications/v1/decision',
    );
    expect(JSON.parse(decision.init.body)).toEqual({
      decision: 'verified',
      reasonCode: 'credentials_confirmed',
    });
  });

  it('patients cannot open the verification queue', async () => {
    signedIn(makeUser(['PATIENT']), {});
    renderAt('/app/admin/verification');
    expect(
      await screen.findByRole('heading', { name: 'You don’t have access to this page' }),
    ).toBeInTheDocument();
  });

  it('a clinic-scoped administrator sees their clinic in navigation and its members', async () => {
    const clinicAdmin = {
      ...makeUser([]),
      roles: ['CLINIC_ADMIN'],
      permissions: ['account:read', 'account:update', 'sessions:read', 'sessions:revoke'],
      clinicRoles: [{ clinicId: CLINIC, role: 'CLINIC_ADMIN' }],
      clinicPermissions: { [CLINIC]: ['clinic:manage', 'clinics:read', 'doctors:read'] },
    };
    signedIn(clinicAdmin, {
      [`GET /api/v1/clinics/${CLINIC}`]: () =>
        json(200, { data: { id: CLINIC, name: 'Sunrise Clinic', city: 'Pune' } }),
      [`GET /api/v1/clinics/${CLINIC}/members`]: () =>
        json(200, {
          data: [
            {
              id: 'm1',
              memberRole: 'DOCTOR',
              status: 'active',
              member: { fullName: 'Dr. Meera', email: 'm@x' },
            },
          ],
        }),
    });
    renderAt('/app/clinic');
    expect(await screen.findByText('Sunrise Clinic')).toBeInTheDocument();
    expect(await screen.findByText('Dr. Meera')).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Doctors & team' })).toBeInTheDocument();
  });
});
