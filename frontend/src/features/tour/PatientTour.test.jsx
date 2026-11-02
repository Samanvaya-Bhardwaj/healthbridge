import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { App } from '../../app/App.jsx';
import { routes } from '../../app/routes.jsx';
import { createQueryClient } from '../../lib/queryClient.js';
import { setAccessToken } from '../../lib/apiClient.js';
import { applyTextSize, savedTextSize } from '../../lib/textSize.js';
import {
  clearCookies,
  fakeApi,
  json,
  makeUser,
  problem,
  sessionPayload,
  setCookie,
} from '../../../tests/fakeApi.js';
import { PatientTour } from './PatientTour.jsx';
import { TOUR_STEPS } from './tourSteps.js';
import { markTourSeen, tourSeen } from './tourSeen.js';

const openHome = (roles = ['PATIENT']) => {
  setCookie('hb_csrf=csrf-1; path=/');
  const user = makeUser(roles);
  fakeApi({
    'POST /api/v1/auth/refresh': () => json(200, sessionPayload(user)),
    'GET /api/v1/auth/me': () => json(200, { data: user }),
    'GET /api/v1/notifications/unread-count': () => json(200, { data: { unreadCount: 0 } }),
    'GET /api/v1/patients/me': () => problem(404, 'not_found'),
  });
  render(
    <App
      router={createMemoryRouter(routes, { initialEntries: ['/app'] })}
      queryClient={createQueryClient()}
    />,
  );
  return user;
};

beforeEach(() => {
  clearCookies();
  setAccessToken(null);
  localStorage.clear();
  delete document.documentElement.dataset.textSize;
  window.requestAnimationFrame = (run) => setTimeout(run, 0);
});
afterEach(() => clearCookies());

describe('the patient tour on the home page', () => {
  it('is offered, not forced: the page stays usable until the person chooses', async () => {
    openHome();
    expect(await screen.findByRole('button', { name: 'Show me around' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Create profile' })).toBeInTheDocument();
  });

  it('runs from start to finish, then stays available from a button', async () => {
    const user = userEvent.setup();
    const person = openHome();
    await user.click(await screen.findByRole('button', { name: 'Show me around' }));
    const tour = await screen.findByRole('dialog');
    expect(within(tour).getByRole('heading', { name: 'Welcome to HealthBridge' })).toBeVisible();
    expect(within(tour).getByText(`Step 1 of ${TOUR_STEPS.length}`)).toBeVisible();
    expect(within(tour).queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();

    for (let i = 1; i < TOUR_STEPS.length; i += 1) {
      await user.click(within(tour).getByRole('button', { name: 'Next' }));
      expect(within(tour).getByRole('heading', { name: TOUR_STEPS[i].title })).toBeVisible();
    }
    await user.click(within(tour).getByRole('button', { name: 'Finish' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(tourSeen(person.id)).toBe(true);
    expect(screen.queryByRole('heading', { name: /New here/ })).not.toBeInTheDocument();
    // Still one press away, for anyone who wants to see it again; a keyboard lands on it.
    const again = screen.getByRole('button', { name: 'Show me around' });
    await waitFor(() => expect(again).toHaveFocus());
  });

  it('Not now puts it away without running it', async () => {
    const user = userEvent.setup();
    const person = openHome();
    await user.click(await screen.findByRole('button', { name: 'Not now' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /New here/ })).not.toBeInTheDocument();
    expect(tourSeen(person.id)).toBe(true);
  });

  it('does not come back for someone who has seen it', async () => {
    const person = makeUser(['PATIENT']);
    markTourSeen(person.id);
    openHome();
    await screen.findByRole('heading', { name: /Welcome/ });
    expect(screen.queryByRole('heading', { name: /New here/ })).not.toBeInTheDocument();
  });
});

describe('the tour itself', () => {
  it('keeps focus in the card when Back leaves it, so a keyboard still works', async () => {
    const user = userEvent.setup();
    render(<PatientTour onClose={() => {}} />);
    const tour = screen.getByRole('dialog');
    await user.click(within(tour).getByRole('button', { name: 'Next' }));
    await user.click(within(tour).getByRole('button', { name: 'Back' }));
    expect(within(tour).getByRole('button', { name: 'Next' })).toHaveFocus();
  });

  it('goes back, and Escape ends it', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<PatientTour onClose={onClose} />);
    const tour = screen.getByRole('dialog');
    await user.click(within(tour).getByRole('button', { name: 'Next' }));
    await user.click(within(tour).getByRole('button', { name: 'Back' }));
    expect(within(tour).getByRole('heading', { name: TOUR_STEPS[0].title })).toBeVisible();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('lights up what a step describes, and keeps the card off it', async () => {
    const user = userEvent.setup();
    const tile = document.createElement('div');
    tile.dataset.tour = 'next';
    tile.getBoundingClientRect = () => ({ top: 600, left: 40, width: 300, height: 100 });
    document.body.append(tile);
    render(<PatientTour onClose={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    const spotlight = screen.getByTestId('tour-spotlight');
    await waitFor(() => expect(spotlight.style.width).toBe('316px'));
    expect(spotlight.style.top).toBe('592px');
    // The tile shows the picture, so the card doesn't repeat it.
    expect(screen.getByRole('dialog').querySelector('img')).toBeNull();
    tile.remove();
  });

  it('still explains a step whose element is not on the screen', async () => {
    const user = userEvent.setup();
    render(<PatientTour onClose={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByRole('dialog').querySelector('img')).not.toBeNull());
    expect(screen.getByRole('heading', { name: TOUR_STEPS[1].title })).toBeVisible();
  });

  it('every step is one short idea', () => {
    for (const step of TOUR_STEPS) expect(step.text.length).toBeLessThanOrEqual(110);
  });
});

describe('larger text', () => {
  it('is a switch for patients, kept for next time', async () => {
    const user = userEvent.setup();
    openHome();
    const toggle = await screen.findByRole('button', { name: 'Larger text' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(document.documentElement.dataset.textSize).toBe('large');
    expect(savedTextSize()).toBe('large');
    await user.click(toggle);
    expect(document.documentElement.dataset.textSize).toBe('normal');
  });

  it('is left out for staff, whose screens are dense on purpose', async () => {
    openHome(['DOCTOR']);
    await screen.findByRole('link', { name: 'HealthBridge home' });
    expect(screen.queryByRole('button', { name: 'Larger text' })).not.toBeInTheDocument();
  });

  it('survives blocked storage', () => {
    const blocked = () => {
      throw new Error('blocked');
    };
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(blocked);
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(blocked);
    expect(savedTextSize()).toBe('normal');
    applyTextSize('large');
    expect(document.documentElement.dataset.textSize).toBe('large');
    expect(tourSeen('someone')).toBe(false);
    expect(() => markTourSeen('someone')).not.toThrow();
    get.mockRestore();
    set.mockRestore();
  });
});
