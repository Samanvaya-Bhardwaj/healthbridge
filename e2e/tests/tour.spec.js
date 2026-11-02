import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { demoEmail, signIn } from './helpers.js';

/**
 * The patient tour on the real app: offered on the home page, one idea at a time, with no
 * accessibility violations on a card, and put away for good once finished.
 */
test('a patient is shown around, once, and can ask to see it again', async ({ page }) => {
  await signIn(page, demoEmail('patient.vikram'));
  await page.goto('/app');

  await page.getByRole('button', { name: 'Show me around' }).click();
  const tour = page.getByRole('dialog');
  await expect(tour.getByRole('heading', { name: 'Welcome to HealthBridge' })).toBeVisible();

  await tour.getByRole('button', { name: 'Next' }).click();
  await tour.getByRole('button', { name: 'Next' }).click();
  await expect(tour.getByRole('heading', { name: 'Find your doctor' })).toBeVisible();
  // The tile is lit up, and the card does not sit on it.
  const tile = await page.locator('[data-tour="doctors"]').boundingBox();
  const card = await tour.boundingBox();
  expect(tile.y + tile.height <= card.y || card.y + card.height <= tile.y).toBe(true);

  const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(scan.violations.filter((v) => ['serious', 'critical'].includes(v.impact))).toEqual([]);

  while (await tour.getByRole('button', { name: 'Next' }).count()) {
    await tour.getByRole('button', { name: 'Next' }).click();
  }
  await tour.getByRole('button', { name: 'Finish' }).click();
  await expect(tour).toBeHidden();

  await page.reload();
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /New here/ })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Show me around' })).toBeVisible();
});
