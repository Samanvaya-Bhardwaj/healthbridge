import { expect, test } from '@playwright/test';
import { demoEmail, nav, signIn } from './helpers.js';

/**
 * Platform administration: account lookup, the audit trail and background-job health —
 * without any route into clinical records (administrators get no automatic access).
 */
test('platform admin manages accounts, reads the audit trail and checks operations', async ({
  page,
}) => {
  await signIn(page, demoEmail('platform.admin'));

  await test.step('find a user and view the account', async () => {
    await nav(page, 'Users').click();
    await page.getByLabel('Name or email').fill('patient.asha');
    await page.getByRole('button', { name: 'Search' }).click();
    const row = page.getByRole('row').filter({ hasText: demoEmail('patient.asha') });
    await row.getByRole('button', { name: 'View' }).click();
    await expect(page.getByRole('heading', { name: /Asha Rao/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Roles' })).toBeVisible();
    // Doctor and clinic roles are never offered for direct grant.
    const offered = await page.getByLabel('Grant a role').locator('option').allTextContents();
    expect(offered).not.toContain('Doctor');
    expect(offered).not.toContain('Clinic administrator');
  });

  await test.step('the lookup itself is in the audit trail', async () => {
    await nav(page, 'Audit log').click();
    await page.getByLabel('Action', { exact: true }).fill('admin.user_read');
    await page.getByRole('button', { name: 'Apply filters' }).click();
    await expect(page.getByText('admin.user_read').first()).toBeVisible();
    await page.getByRole('button', { name: 'Details' }).first().click();
    await expect(page.getByText('IP address')).toBeVisible();
  });

  await test.step('operations shows queue health', async () => {
    await nav(page, 'Operations').click();
    await expect(page.getByRole('heading', { name: 'Outbox events' })).toBeVisible();
    await expect(page.getByRole('rowheader', { name: /notifications/ })).toBeVisible();
  });

  await test.step('no clinical records for administrators', async () => {
    await expect(nav(page, 'Patient Records')).toHaveCount(0);
    await page.goto('/app/medical-records');
    await expect(
      page.getByRole('heading', { name: 'You don’t have access to this page' }),
    ).toBeVisible();
    await expect(
      page.getByText(/^Platform administrators do not have access to clinical records\./),
    ).toBeVisible();
  });
});
