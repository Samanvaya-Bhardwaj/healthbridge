import { expect, test } from '@playwright/test';
import { demoEmail, nav, signIn } from './helpers.js';

/**
 * M13.1 smoke journey through the real stack (API → AI service with the deterministic
 * fake model → backend tools): the patient asks in plain words, gets grounded, clearly
 * labelled suggestions, and booking stays on the existing booking page. Synthetic data.
 */
test('patient asks the assistant for a doctor and gets grounded suggestions', async ({ page }) => {
  await signIn(page, demoEmail('patient.asha'));
  await nav(page, 'Assistant').click();
  await expect(page.getByRole('heading', { name: 'HealthBridge Assistant' })).toBeVisible();

  await page.getByLabel('Your message').fill('I need a general physician on monday morning');
  await page.getByRole('button', { name: 'Send' }).click();

  await expect(page.getByText('AI suggestion')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('p', { hasText: 'What I understood:' })).toContainText(
    'General Medicine',
  );
  const meera = page.getByRole('listitem').filter({ hasText: 'Dr. Meera Iyer' }).first();
  await expect(meera).toBeVisible();
  await expect(meera.getByText('In your care team')).toBeVisible();
  // Suggestions are never presented as bookings; booking is the existing confirmed flow.
  await expect(page.getByText('Suggested · not booked')).toBeVisible();
  await meera.getByRole('link', { name: 'Book with Dr. Meera Iyer' }).click();
  await expect(page.getByRole('heading', { name: 'Book a consultation' })).toBeVisible();

  // Possible emergencies get fixed guidance, without a booking prompt.
  await nav(page, 'Assistant').click();
  await page.getByLabel('Your message').fill('I have chest pain');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('alert')).toContainText('call 112 or 108');
});
