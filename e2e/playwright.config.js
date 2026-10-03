import { defineConfig, devices } from '@playwright/test';

// Runs against a live stack (docker compose up) seeded with synthetic demo data
// (npm run seed:demo -w backend). Never point this at an environment with real patients.
try {
  process.loadEnvFile(new URL('../.env', import.meta.url));
} catch {
  // CI provides the environment directly.
}

const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${process.env.HOST_PORT_WEB ?? 8080}`;

export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.js',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  // Journeys share demo accounts and the clock-driven slot grid: run them one at a time.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, grep: /@mobile/ },
  ],
});
