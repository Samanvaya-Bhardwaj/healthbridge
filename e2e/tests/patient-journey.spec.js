import { expect, test } from '@playwright/test';
import { demoEmail, nav, signIn, syntheticPatient } from './helpers.js';

/**
 * The core patient journey through the real stack (Nginx → API → PostgreSQL, workers,
 * fake payment provider): register → health profile → choose a trusted doctor → the
 * doctor accepts → book an online consultation → pay → confirmed → notified.
 * Synthetic data only.
 */
test('patient registers, joins a doctor’s care, books and pays for a consultation', async ({
  browser,
}) => {
  const person = syntheticPatient();
  const patientContext = await browser.newContext();
  const patient = await patientContext.newPage();

  await test.step('register and sign in', async () => {
    await patient.goto('/register');
    await patient.getByLabel('Full name').fill(person.fullName);
    await patient.getByLabel('Email').fill(person.email);
    await patient.getByLabel('Password').fill(person.password);
    await patient.getByRole('checkbox').check();
    await patient.getByRole('button', { name: 'Create account' }).click();
    // Registration never signs in or reveals whether the email existed (no enumeration).
    await expect(patient.getByText(/you can now sign in/)).toBeVisible();
    await signIn(patient, person.email, person.password);
    await expect(patient.getByRole('heading', { name: /Welcome, Test/ })).toBeVisible();
  });

  await test.step('create the health profile', async () => {
    await nav(patient, 'Profile').click();
    await expect(
      patient.getByRole('heading', { name: 'Create your health profile' }),
    ).toBeVisible();
    await expect(patient.getByLabel('Full name')).toHaveValue(person.fullName);
    await patient.getByLabel('Date of birth').fill('1990-04-12');
    await patient.getByRole('button', { name: 'Create profile' }).click();
    await expect(patient.getByRole('heading', { name: 'Create your health profile' })).toBeHidden();
  });

  await test.step('ask Dr. Meera to join the care team', async () => {
    await nav(patient, 'Doctors').click();
    await patient.getByPlaceholder('Name or specialty').fill('Meera');
    await patient.getByRole('button', { name: 'Search' }).click();
    const row = patient.getByRole('listitem').filter({ hasText: 'Dr. Meera Iyer' });
    await row.getByRole('button', { name: 'Request' }).click();
    await expect(patient.getByText(/request/i).first()).toBeVisible();
  });

  await test.step('the doctor accepts (separate browser session)', async () => {
    const doctorContext = await browser.newContext();
    const doctor = await doctorContext.newPage();
    await signIn(doctor, demoEmail('dr.meera'));
    await nav(doctor, 'Patients').click();
    const request = doctor.getByRole('listitem').filter({ hasText: person.fullName });
    await request.getByRole('button', { name: 'Accept' }).click();
    await expect(request.getByRole('button', { name: 'Accept' })).toBeHidden();
    await doctorContext.close();
  });

  await test.step('book the first paid in-clinic slot (online consults are free in the demo)', async () => {
    await nav(patient, 'Doctors').click();
    await patient.reload();
    await patient.getByRole('link', { name: 'Book' }).first().click();
    await expect(patient.getByRole('heading', { name: 'Book an appointment' })).toBeVisible();
    await patient.getByRole('button', { name: 'In clinic' }).click();
    await patient.getByRole('tabpanel').getByRole('button').first().click();
    await patient.getByLabel('Reason for visit').fill('Routine review (synthetic)');
    await patient.getByRole('button', { name: 'Book appointment' }).click();
    await expect(patient.getByRole('heading', { name: 'Complete payment' })).toBeVisible();
  });

  await test.step('pay with the test provider; the server confirms via webhook', async () => {
    await patient.getByRole('button', { name: /^Pay / }).click();
    await patient.getByRole('button', { name: 'Simulate successful payment' }).click();
    // Confirmed only by the signed webhook (the browser never decides payment succeeded).
    await expect(patient.getByText(/confirmed/i).first()).toBeVisible({ timeout: 30_000 });
    await patient.goto('/app/appointments');
    await expect(
      patient.getByRole('listitem').filter({ hasText: 'In clinic' }).getByText('Confirmed'),
    ).toBeVisible();
  });

  await test.step('the confirmation reaches the in-app inbox', async () => {
    await expect(async () => {
      await patient.goto('/app/notifications');
      await expect(
        patient.getByText('Payment received – appointment confirmed').first(),
      ).toBeVisible({
        timeout: 2_000,
      });
    }).toPass({ timeout: 45_000 });
  });

  await test.step('a patient cannot open administration pages', async () => {
    await patient.goto('/app/admin/users');
    await expect(
      patient.getByRole('heading', { name: 'You don’t have access to this page' }),
    ).toBeVisible();
  });

  await patientContext.close();
});
