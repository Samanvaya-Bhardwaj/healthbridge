import { expect, test } from '@playwright/test';
import { demoEmail, nav, signIn } from './helpers.js';

/**
 * The assistant through the real stack (API → AI service with the deterministic fake
 * model → backend tools), with synthetic data: grounded suggestions, then booking in the
 * conversation (ADR-0038): a doctor, a time, the person's Confirm, payment when the time
 * is paid, and the calendar links. Each journey cancels what it booked, so repeated runs
 * leave the demo schedule as it was.
 */
async function ask(page, text) {
  await page.getByLabel('Your message').fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
}

/** Opens the booked appointment and cancels it (the patient's own flow). */
async function cancelFromAppointment(page) {
  await page.getByRole('link', { name: 'Open the appointment' }).click();
  await page.getByRole('button', { name: 'Cancel appointment' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel appointment' }).click();
  await expect(page.getByText('Cancelled').first()).toBeVisible();
}

test('patient asks the assistant for a doctor and books an online time in the conversation', async ({
  page,
}) => {
  await signIn(page, demoEmail('patient.asha'));
  await nav(page, 'Assistant').click();
  await expect(page.getByRole('heading', { name: 'HealthBridge Assistant' })).toBeVisible();

  await ask(page, 'I need a general physician for an online consultation');
  await expect(page.getByText('AI suggestion')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('p', { hasText: 'What I understood:' })).toContainText(
    'General Medicine',
  );
  // Meera's own card, first: she is in Asha's care team.
  const meera = page
    .getByRole('listitem')
    .filter({ hasText: 'Dr. Meera Iyer' })
    .filter({ has: page.getByRole('button', { name: 'Book' }) })
    .last();
  await expect(meera.getByText('In your care team', { exact: true })).toBeVisible();
  await meera.getByRole('button', { name: 'Book' }).click();

  // Free times with her; choosing one shows the booking, not booked yet.
  const times = page.getByRole('button', { name: /choose this time/ });
  await expect(times.first()).toBeVisible({ timeout: 20_000 });
  await times.first().click();
  const booking = page.getByRole('region', { name: 'Booking to confirm' });
  await expect(booking).toBeVisible({ timeout: 20_000 });
  await expect(booking.getByText('Not booked yet')).toBeVisible();
  await booking.getByLabel('Reason for the visit').fill('Synthetic: review of home sugar readings');
  await booking.getByRole('button', { name: 'Confirm booking' }).click();

  const booked = page.getByRole('region', { name: 'Booked' });
  await expect(booked).toBeVisible({ timeout: 20_000 });
  await expect(booked.getByRole('link', { name: /Google Calendar/ })).toBeVisible();
  await cancelFromAppointment(page);

  // Possible emergencies get fixed guidance, without a booking prompt.
  await nav(page, 'Assistant').click();
  await ask(page, 'I have chest pain');
  await expect(page.getByRole('alert')).toContainText('call 112 or 108');
});

test('a paid in-clinic time is booked and paid in the conversation', async ({ page }) => {
  await signIn(page, demoEmail('patient.asha'));
  await nav(page, 'Assistant').click();
  await ask(page, 'I want to book an in-clinic visit with a general physician');
  const meera = page
    .getByRole('listitem')
    .filter({ hasText: 'Dr. Meera Iyer' })
    .filter({ has: page.getByRole('button', { name: 'Book' }) })
    .last();
  await meera.getByRole('button', { name: 'Book' }).click({ timeout: 20_000 });
  await page
    .getByRole('button', { name: /In clinic: choose this time/ })
    .first()
    .click({
      timeout: 20_000,
    });
  const booking = page.getByRole('region', { name: 'Booking to confirm' });
  await expect(booking.getByText('₹500.00')).toBeVisible({ timeout: 20_000 });
  await booking.getByLabel('Reason for the visit').fill('Synthetic: blood pressure check');
  await booking.getByRole('button', { name: 'Confirm booking' }).click();

  const pay = page.getByRole('region', { name: 'Payment' });
  await pay.getByRole('button', { name: /^Pay / }).click({ timeout: 20_000 });
  await page.getByRole('button', { name: /test payment/ }).click();
  const booked = page.getByRole('region', { name: 'Booked' });
  await expect(booked).toContainText('Booked and paid', { timeout: 30_000 });
  await cancelFromAppointment(page);
});

test('a described concern gets general information from the health library, then doctors (ADR-0040)', async ({
  page,
}) => {
  await signIn(page, demoEmail('patient.vikram'));
  await nav(page, 'Assistant').click();
  await ask(page, 'I am having acidity for past 3 days, i took unienzyme but nothing changes');
  const info = page.getByRole('region', { name: 'General information: Acidity and heartburn' });
  await expect(info).toBeVisible({ timeout: 20_000 });
  await expect(info.getByText('AI summary for your message')).toBeVisible();
  await expect(info.getByRole('heading', { name: 'What may help' })).toBeVisible();
  await expect(info.getByRole('note')).toContainText('call 112');
  await expect(info.getByText(/not a doctor/)).toBeVisible();
  await expect(info).not.toContainText(/unienzyme/i);
  // The doctors who can help follow the information.
  await expect(page.getByRole('button', { name: 'Book' }).first()).toBeVisible();
});
