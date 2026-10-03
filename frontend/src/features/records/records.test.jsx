import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
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

const PATIENT = '0192b6f0-0000-7000-8000-0000000000a1';
const DOC = '0192b6f0-0000-7000-8000-0000000000f1';
const now = new Date().toISOString();

const doc = (overrides = {}) => ({
  id: DOC,
  patientId: PATIENT,
  documentType: 'lab_report',
  title: 'Synthetic CBC',
  originalFilename: 'cbc.pdf',
  contentType: 'application/pdf',
  sizeBytes: 2048,
  status: 'available',
  rejectionReason: null,
  uploadedBy: { relationship: 'patient_self', name: 'Asha Rao' },
  createdAt: now,
  ...overrides,
});

function signedIn(roles, routesMap) {
  setCookie('hb_csrf=csrf-1; path=/');
  const user = makeUser(roles);
  return fakeApi({
    'POST /api/v1/auth/refresh': () => json(200, sessionPayload(user)),
    'GET /api/v1/auth/me': () => json(200, { data: user }),
    'GET /api/v1/patients/me': () => json(200, { data: { id: PATIENT, fullName: 'Asha Rao' } }),
    'GET /api/v1/patients/me/dependents': () => json(200, { data: [] }),
    ...routesMap,
  });
}

function renderAt(path) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={createQueryClient()} />);
  return router;
}

/** Stand-in for the presigned POST to object storage (no network in tests). */
class FakeXhr {
  static requests = [];
  upload = {};
  open(method, url) {
    this.method = method;
    this.url = url;
  }
  send(form) {
    FakeXhr.requests.push({ url: this.url, form });
    this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 1 });
    this.status = 204;
    setTimeout(() => this.onload());
  }
}

beforeEach(() => {
  clearCookies();
  setAccessToken(null);
  FakeXhr.requests = [];
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
});
afterEach(() => {
  clearCookies();
  vi.unstubAllGlobals();
});

describe('health records', () => {
  it('uploads straight to storage, completes, and shows the safety-check status', async () => {
    let list = [
      doc({
        status: 'rejected',
        rejectionReason: 'infected',
        id: `${DOC.slice(0, -1)}2`,
        title: 'Old scan',
      }),
    ];
    const calls = signedIn(['PATIENT'], {
      [`GET /api/v1/patients/${PATIENT}/documents`]: () => json(200, { data: list }),
      [`POST /api/v1/patients/${PATIENT}/documents/upload-intent`]: () =>
        json(201, {
          data: {
            document: doc({ status: 'pending_upload' }),
            upload: {
              method: 'POST',
              url: 'http://storage.test/bucket',
              fields: { key: 'quarantine/x', policy: 'p' },
            },
          },
        }),
      [`POST /api/v1/documents/${DOC}/complete`]: () => {
        list = [doc({ status: 'quarantined' }), ...list];
        return json(200, { data: doc({ status: 'quarantined' }) });
      },
    });
    renderAt('/app/records');
    expect(await screen.findByText('The file failed the safety scan.')).toBeInTheDocument();

    const file = new File(['%PDF-1.4 synthetic'], 'cbc.pdf', { type: 'application/pdf' });
    await userEvent.upload(screen.getByLabelText('File'), file);
    await userEvent.type(screen.getByLabelText(/^Name/), 'Synthetic CBC');
    await userEvent.click(screen.getByRole('button', { name: 'Upload' }));

    expect(await screen.findByText('Waiting for the safety check')).toBeInTheDocument();
    const intent = calls.find((c) => c.key.endsWith('/upload-intent'));
    const body = JSON.parse(intent.init.body);
    expect(body).toMatchObject({
      documentType: 'lab_report',
      title: 'Synthetic CBC',
      filename: 'cbc.pdf',
      contentType: 'application/pdf',
      sizeBytes: file.size,
    });
    expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);
    // The file goes to storage (presigned POST), never through the API.
    expect(FakeXhr.requests).toHaveLength(1);
    expect(FakeXhr.requests[0].form.get('key')).toBe('quarantine/x');
    expect(calls.some((c) => c.key.includes('/complete'))).toBe(true);
  });

  it('rejects unsupported files before uploading', async () => {
    signedIn(['PATIENT'], {
      [`GET /api/v1/patients/${PATIENT}/documents`]: () => json(200, { data: [] }),
    });
    renderAt('/app/records');
    await screen.findByText('No documents yet');
    const file = new File(['<html>'], 'page.html', { type: 'text/html' });
    await userEvent.upload(screen.getByLabelText('File'), file, { applyAccept: false });
    await userEvent.click(screen.getByRole('button', { name: 'Upload' }));
    expect(await screen.findByText('Choose a PDF, PNG or JPEG file.')).toBeInTheDocument();
    expect(FakeXhr.requests).toHaveLength(0);
  });
});

describe('privacy and access', () => {
  it('lists who has access, revokes, and shows the access log in plain language', async () => {
    let consents = [
      {
        id: 'c1',
        patientId: PATIENT,
        doctor: { id: 'd1', professionalName: 'Dr. Meera Iyer' },
        kind: 'manual',
        scopes: ['medical_documents'],
        documentTypes: null,
        purpose: 'ongoing_care',
        status: 'active',
        expiresAt: now,
      },
    ];
    const calls = signedIn(['PATIENT'], {
      [`GET /api/v1/consents?patientId=${PATIENT}`]: () => json(200, { data: consents }),
      [`GET /api/v1/care-relationships?patientId=${PATIENT}`]: () => json(200, { data: [] }),
      [`GET /api/v1/patients/${PATIENT}/access-log?limit=30`]: () =>
        json(200, {
          data: [
            {
              occurredAt: now,
              actor: { kind: 'doctor', name: 'Dr. Meera Iyer' },
              action: 'document.download_authorized',
              outcome: 'success',
              description: 'Dr. Meera Iyer downloaded “Synthetic CBC”',
            },
          ],
          meta: { nextCursor: null },
        }),
      'POST /api/v1/consents/c1/revoke': () => {
        consents = [{ ...consents[0], status: 'revoked' }];
        return json(200, { data: consents[0] });
      },
    });
    renderAt('/app/privacy');
    expect(
      await screen.findByText('Dr. Meera Iyer downloaded “Synthetic CBC”'),
    ).toBeInTheDocument();
    expect(screen.getByText(/View documents · Ongoing care/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    // Revoking asks first: it blocks the doctor's very next request.
    const dialog = await screen.findByRole('dialog', { name: 'Revoke Dr. Meera Iyer’s access?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Revoke access' }));
    expect(await screen.findByText('No doctor can see your records')).toBeInTheDocument();
    expect(calls.some((c) => c.key === 'POST /api/v1/consents/c1/revoke')).toBe(true);
  });
});

describe('doctor view', () => {
  it('explains a missing or ended consent instead of showing records', async () => {
    signedIn(['DOCTOR'], {
      [`GET /api/v1/patients/${PATIENT}/documents`]: () =>
        problem(403, 'consent_required', 'Patient consent is required to access this record.'),
    });
    renderAt(`/app/medical-records/${PATIENT}`);
    expect(await screen.findByText(/has not given you access/)).toBeInTheDocument();
  });
});
