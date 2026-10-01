import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createMemoryRouter } from 'react-router';
import { App } from './App.jsx';
import { createQueryClient } from '../lib/queryClient.js';
import { routes } from './routes.jsx';

function renderAt(path) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return render(<App router={router} queryClient={createQueryClient()} />);
}

const meta = (overrides = {}) =>
  new Response(
    JSON.stringify({
      data: {
        name: 'HealthBridge API',
        apiVersion: 'v1',
        version: '0.1.0',
        demoMode: false,
        ...overrides,
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

describe('App shell', () => {
  it('renders the home page with positioning and an online status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(meta());
    renderAt('/');
    expect(
      screen.getByRole('heading', { level: 1, name: /consult your trusted local doctor first/i }),
    ).toBeInTheDocument();
    expect(await screen.findByText(/service online/i)).toBeInTheDocument();
  });

  it('shows the synthetic-data banner in demo mode', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(meta({ demoMode: true }));
    renderAt('/');
    expect(
      await screen.findByText(/all patients, doctors and medical records shown are synthetic/i),
    ).toBeInTheDocument();
  });

  it('reports the service as unavailable when the API cannot be reached', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    renderAt('/');
    expect(
      await screen.findByText(/service unavailable/i, {}, { timeout: 4000 }),
    ).toBeInTheDocument();
  });

  it('renders a not-found page for unknown routes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(meta());
    renderAt('/does-not-exist');
    expect(screen.getByRole('heading', { name: /page not found/i })).toBeInTheDocument();
  });
});
