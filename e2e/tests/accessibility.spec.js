import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { resetLocalRateLimits } from '../rateLimits.js';
import { demoEmail, signIn } from './helpers.js';

/**
 * Step 11: automated accessibility checks (axe-core, WCAG 2.0/2.1 A and AA) on the public
 * pages and each role's main workspace pages, with the synthetic demo data loaded.
 * Serious and critical violations fail the run; the rest are printed for review.
 * Automated checks find a subset of issues only: keyboard and screen-reader passes stay
 * manual (docs/VALIDATION.md).
 */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function scan(page, label) {
  // Wait for the page's own content (skeletons gone) before scanning.
  await page.waitForLoadState('networkidle');
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 15_000 });
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const blocking = result.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
  const minor = result.violations.filter((v) => !blocking.includes(v));
  console.log(
    `[a11y] ${label}: ${result.passes.length} rules passed` +
      (minor.length ? `; minor: ${minor.map((v) => `${v.id} (${v.impact})`).join(', ')}` : ''),
  );
  expect(
    blocking.map((v) => ({
      page: label,
      rule: v.id,
      impact: v.impact,
      help: v.help,
      targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')),
    })),
  ).toEqual([]);
}

async function scanAll(page, paths) {
  for (const [label, path] of paths) {
    await page.goto(path);
    await scan(page, label);
  }
}

test.describe('accessibility (WCAG 2.1 AA, automated)', () => {
  // Each workspace scan loads many pages from one IP; start every one with fresh counters.
  test.beforeEach(() => resetLocalRateLimits(['auth-', 'api-global']));

  test('public pages @mobile', async ({ page }) => {
    await scanAll(page, [
      ['sign in', '/login'],
      ['register', '/register'],
      ['forgot password', '/forgot-password'],
    ]);
  });

  test('patient workspace', async ({ page }) => {
    await signIn(page, demoEmail('patient.asha'));
    await scanAll(page, [
      ['patient home', '/app'],
      ['my doctors', '/app/doctors'],
      ['appointments', '/app/appointments'],
      ['booking', '/app/appointments/book'],
      ['health records', '/app/records'],
      ['prescriptions', '/app/prescriptions'],
      ['timeline', '/app/timeline'],
      ['follow-ups', '/app/follow-ups'],
      ['privacy and access', '/app/privacy'],
      ['assistant', '/app/assistant'],
      ['notifications', '/app/notifications'],
      ['account settings', '/app/account'],
    ]);
  });

  test('doctor workspace', async ({ page }) => {
    await signIn(page, demoEmail('dr.meera'));
    await scanAll(page, [
      ['doctor today', '/app'],
      ['my patients', '/app/patients'],
      ['schedule', '/app/appointments'],
      ['follow-ups', '/app/follow-ups'],
      ['professional profile', '/app/doctor-profile'],
    ]);
  });

  test('administration', async ({ page }) => {
    await signIn(page, demoEmail('platform.admin'));
    await scanAll(page, [
      ['admin overview', '/app'],
      ['users', '/app/admin/users'],
      ['verification', '/app/admin/verification'],
      ['clinics', '/app/admin/clinics'],
      ['audit log', '/app/admin/audit'],
      ['operations', '/app/admin/operations'],
    ]);
  });
});
