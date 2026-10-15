import { expect, test } from '@playwright/test';
import { demoEmail, nav, signIn } from './helpers.js';

/**
 * Step 11: the records journeys on the seeded clinical history (seed-demo.js →
 * seedHistory.js): past visits with signed notes and prescriptions (one corrected),
 * check-ins and synthetic lab reports. Read-only, so reruns see the same data.
 */
test('patient sees their prescriptions, a correction, the timeline, check-ins and medicines', async ({
  page,
}) => {
  await signIn(page, demoEmail('patient.asha'));

  await nav(page, 'Prescriptions').click();
  await expect(page.getByRole('heading', { name: 'Prescriptions' })).toBeVisible();
  await expect(page.getByText(/Metformin 500 mg/).first()).toBeVisible();
  // A correction is a new signed version that says why.
  await expect(page.getByText(/corrected the vitamin D duration/).first()).toBeVisible();

  await nav(page, 'Timeline').click();
  await expect(page.getByText(/Dr\. Meera Iyer/).first()).toBeVisible();

  await nav(page, 'Follow-ups').click();
  await expect(page.getByRole('heading', { name: 'Follow-ups' })).toBeVisible();
  // The check-in still to come (or already open: other suites may move clocks forward).
  await expect(page.getByText('Check-in from Dr. Meera Iyer').first()).toBeVisible();

  // The assistant shows the medicines from the record, apart from AI suggestions.
  await nav(page, 'Assistant').click();
  await page.getByLabel('Your message').fill('What medicines do I need to take?');
  await page.getByRole('button', { name: 'Send' }).click();
  const medicines = page.getByRole('region', { name: 'Medicines on your recent prescriptions' });
  await expect(medicines).toBeVisible({ timeout: 20_000 });
  await expect(medicines.getByText('From your records')).toBeVisible();
  await expect(medicines.getByText(/Metformin 500 mg/).first()).toBeVisible();
});

test('doctor opens a shared record: prescriptions, shared documents, timeline', async ({
  page,
}) => {
  await signIn(page, demoEmail('dr.meera'));
  await nav(page, 'Patient Records').click();
  const asha = page.getByRole('listitem').filter({ hasText: 'Asha Rao' });
  await asha.getByRole('link', { name: 'Open records' }).click();
  await expect(page.getByRole('heading', { name: 'Asha Rao' })).toBeVisible();

  // Overview: her signed prescriptions, newest first.
  await expect(page.getByText(/Metformin 500 mg/).first()).toBeVisible();

  // Documents the patient shared (lab values read by AI stay proposals until verified).
  await page.getByRole('tab', { name: 'Documents' }).click();
  await expect(page.getByText('Blood sugar and HbA1c (synthetic)')).toBeVisible();

  await page.getByRole('tab', { name: 'Timeline' }).click();
  await expect(page.getByText(/Dr\. Meera Iyer/).first()).toBeVisible();
});
