import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const PATIENT = '0192b6f0-0000-7000-8000-0000000000a1';
const events = [
  {
    id: 'e1',
    type: 'lab_result',
    occurredAt: '2026-09-20T12:00:00Z',
    datePrecision: 'day',
    title: 'WBC: 11.9 10^3/uL',
    status: 'high',
    provenance: 'doctor_verified',
    provenanceLabel: 'Verified by a doctor',
    actor: 'Dr. Meera Iyer',
    detail: {},
  },
  {
    id: 'e2',
    type: 'document',
    occurredAt: '2026-08-14T12:00:00Z',
    datePrecision: 'day',
    title: 'Synthetic CBC',
    status: 'available',
    provenance: 'patient_reported',
    provenanceLabel: 'Added by the patient',
    actor: null,
    detail: { aiDerivedFields: ['documentDate'] },
  },
];

beforeEach(() => {
  clearCookies();
  setAccessToken(null);
});
afterEach(() => {
  clearCookies();
  vi.restoreAllMocks();
});

describe('health timeline', () => {
  it('shows provenance for every entry, groups by month and exports JSON', async () => {
    setCookie('hb_csrf=csrf-1; path=/');
    const user = makeUser(['PATIENT']);
    const calls = fakeApi({
      'POST /api/v1/auth/refresh': () => json(200, sessionPayload(user)),
      'GET /api/v1/auth/me': () => json(200, { data: user }),
      'GET /api/v1/patients/me': () => json(200, { data: { id: PATIENT } }),
      'GET /api/v1/patients/me/dependents': () => json(200, { data: [] }),
      [`GET /api/v1/patients/${PATIENT}/timeline?limit=30`]: () =>
        json(200, { data: events, meta: { nextCursor: null } }),
      [`GET /api/v1/patients/${PATIENT}/timeline/export`]: () =>
        json(200, { format: 'healthbridge.timeline.v1', events }),
    });
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    const router = createMemoryRouter(routes, { initialEntries: ['/app/timeline'] });
    render(<App router={router} queryClient={createQueryClient()} />);

    expect(await screen.findByText('WBC: 11.9 10^3/uL')).toBeInTheDocument();
    expect(screen.getByText('Verified by a doctor')).toBeInTheDocument();
    expect(screen.getByText('Added by the patient')).toBeInTheDocument();
    expect(screen.getByText('Date/issuer read by AI')).toBeInTheDocument();
    expect(screen.getByText('September 2026')).toBeInTheDocument();
    expect(screen.getByText('August 2026')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Export (JSON)' }));
    expect(calls.some((c) => c.key.endsWith('/timeline/export'))).toBe(true);
    expect(URL.createObjectURL).toHaveBeenCalled();
  });
});
