import { expect } from '@playwright/test';

/** Demo accounts are synthetic (seed-demo.js); the password comes from the environment. */
export const DEMO_PASSWORD = process.env.DEMO_USER_PASSWORD;
export const demoEmail = (local) => `${local}@demo.healthbridge.local`;

/** A unique synthetic person for one run (never a real name or address). */
export function syntheticPatient() {
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return {
    fullName: `Test Patient ${tag}`,
    email: `e2e.${tag}@test.healthbridge.local`,
    // Independent of the name: the password policy rejects passwords containing it.
    password: `meadow lantern ${Math.random().toString(36).slice(2, 10)} river`,
  };
}

export async function signIn(page, email, password = DEMO_PASSWORD) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app/);
}

/** A link in the main workspace navigation. */
export const nav = (page, name) =>
  page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true });
