import { expect, test } from '@playwright/test';
import { signIn, syntheticPatient } from './helpers.js';

// Local/CI Mailpit captures every email the stack sends (no real delivery).
const MAILPIT =
  process.env.E2E_MAILPIT_URL ?? `http://localhost:${process.env.HOST_PORT_MAILPIT_UI ?? 8025}`;

async function latestEmail(request, to, subject) {
  let found;
  await expect(async () => {
    const search = await request.get(`${MAILPIT}/api/v1/search`, {
      params: { query: `to:"${to}" subject:"${subject}"` },
    });
    expect(search.ok()).toBe(true);
    const { messages } = await search.json();
    expect(messages.length).toBeGreaterThan(0);
    found = await (await request.get(`${MAILPIT}/api/v1/message/${messages[0].ID}`)).json();
  }).toPass({ timeout: 20_000 });
  return found.Text;
}

/**
 * Forgotten password through the real stack: the emailed link carries a single-use token
 * in the URL fragment; the reset signs the account out everywhere; email confirmation
 * arrives with registration. Synthetic accounts only.
 */
test('a patient confirms their email and resets a forgotten password', async ({
  page,
  request,
}) => {
  const person = syntheticPatient();
  await page.goto('/register');
  await page.getByLabel('Full name').fill(person.fullName);
  await page.getByLabel('Email').fill(person.email);
  await page.getByLabel('Password').fill(person.password);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText(/Nearly there: sign in below/)).toBeVisible();

  await test.step('confirm the email address from the welcome email', async () => {
    const text = await latestEmail(request, person.email, 'Confirm your email');
    const link = text.match(/https?:\/\/\S+\/verify-email#token=\S+/)[0];
    await page.goto(new URL(link).pathname + new URL(link).hash);
    await expect(page.getByText('Thank you — your email is confirmed.')).toBeVisible();
    expect(new URL(page.url()).hash).toBe('');
  });

  const newPassword = `amber canyon ${Math.random().toString(36).slice(2, 10)} tide`;
  await test.step('request a reset link and choose a new password', async () => {
    await page.goto('/login');
    await page.getByRole('link', { name: 'Forgot your password?' }).click();
    await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible();
    await page.getByLabel('Email').fill(person.email);
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByText(/If an account uses this email/)).toBeVisible();

    const text = await latestEmail(request, person.email, 'Reset your HealthBridge password');
    const link = text.match(/https?:\/\/\S+\/reset-password#token=\S+/)[0];
    await page.goto(new URL(link).pathname + new URL(link).hash);
    expect(new URL(page.url()).hash).toBe(''); // the token leaves the address bar at once
    await page.getByLabel('New password', { exact: true }).fill(newPassword);
    await page.getByLabel('Confirm new password').fill(newPassword);
    await page.getByRole('button', { name: 'Set new password' }).click();
    await expect(page.getByText(/signed out everywhere/)).toBeVisible();

    // The same link cannot be used twice (load it afresh, not as a hash change).
    await page.goto('/login');
    await page.goto(new URL(link).pathname + new URL(link).hash);
    await page.getByLabel('New password', { exact: true }).fill(`${newPassword} again`);
    await page.getByLabel('Confirm new password').fill(`${newPassword} again`);
    await page.getByRole('button', { name: 'Set new password' }).click();
    await expect(page.getByText(/invalid or has expired/)).toBeVisible();
  });

  await test.step('only the new password works', async () => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(person.email);
    await page.getByLabel('Password').fill(person.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('Invalid email or password.')).toBeVisible();
    await signIn(page, person.email, newPassword);
  });
});
