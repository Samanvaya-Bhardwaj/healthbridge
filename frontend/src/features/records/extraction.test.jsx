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
  sessionPayload,
  setCookie,
} from '../../../tests/fakeApi.js';

const PATIENT = '0192b6f0-0000-7000-8000-0000000000a1';
const DOC = '0192b6f0-0000-7000-8000-0000000000f1';

const extraction = (verified = false) => ({
  extractionId: 'x1',
  version: 1,
  status: 'completed',
  source: 'ai_extracted',
  needsReview: false,
  injectionWarning: false,
  documentDate: '2026-09-14',
  issuer: 'Sunrise Diagnostics Laboratory',
  labResults: [
    {
      key: 'lab-1-wbc',
      analyte: 'WBC',
      value: '11.8',
      unit: '10^3/uL',
      referenceRange: '4.0-11.0',
      flag: 'high',
      quote: 'WBC: 11.8 10^3/uL (ref 4.0-11.0)',
      verified,
    },
  ],
});

beforeEach(() => {
  clearCookies();
  setAccessToken(null);
});
afterEach(() => clearCookies());

describe('AI-extracted values', () => {
  it('a doctor sees suggestions with their source and verifies selected values by key only', async () => {
    let verified = false;
    setCookie('hb_csrf=csrf-1; path=/');
    const user = makeUser(['DOCTOR']);
    const calls = fakeApi({
      'POST /api/v1/auth/refresh': () => json(200, sessionPayload(user)),
      'GET /api/v1/auth/me': () => json(200, { data: user }),
      [`GET /api/v1/patients/${PATIENT}/documents`]: () =>
        json(200, {
          data: [
            {
              id: DOC,
              patientId: PATIENT,
              documentType: 'lab_report',
              title: 'Synthetic CBC',
              status: 'available',
              sizeBytes: 2048,
              createdAt: new Date().toISOString(),
              uploadedBy: { relationship: 'patient_self', name: 'Asha' },
            },
          ],
        }),
      [`GET /api/v1/patients/${PATIENT}/lab-results`]: () => json(200, { data: [] }),
      [`GET /api/v1/documents/${DOC}/extraction`]: () => json(200, { data: extraction(verified) }),
      [`POST /api/v1/documents/${DOC}/lab-results/verify`]: () => {
        verified = true;
        return json(200, { data: { verified: 1, alreadyVerified: 0 } });
      },
    });
    const router = createMemoryRouter(routes, {
      initialEntries: [`/app/medical-records/${PATIENT}`],
    });
    render(<App router={router} queryClient={createQueryClient()} />);

    await userEvent.click(await screen.findByText('Review extracted values'));
    expect(await screen.findByText('“WBC: 11.8 10^3/uL (ref 4.0-11.0)”')).toBeInTheDocument();
    expect(screen.getByText('AI-extracted')).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText('Verify WBC'));
    await userEvent.click(screen.getByRole('button', { name: 'Verify selected (1)' }));
    expect(await screen.findByText('Verified')).toBeInTheDocument();
    const call = calls.find((c) => c.key.endsWith('/lab-results/verify'));
    expect(JSON.parse(call.init.body)).toEqual({ fieldKeys: ['lab-1-wbc'] });
  });
});
