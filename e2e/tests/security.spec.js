import { expect, test } from '@playwright/test';

/** Edge security checks through Nginx (no sign-in needed). */
test.describe('security boundaries', () => {
  test('the workspace requires sign-in @mobile', async ({ page }) => {
    await page.goto('/app/records');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  });

  test('responses carry security headers; API errors are not cached', async ({ request }) => {
    const html = await request.get('/');
    const headers = html.headers();
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBeTruthy();
    expect(headers['server'] ?? '').not.toMatch(/\d/); // no version disclosure

    const api = await request.get('/api/v1/patients/me');
    expect(api.status()).toBe(401);
    expect(api.headers()['content-type']).toContain('application/problem+json');
  });

  test('operator tools are not reachable through the public edge', async ({ request }) => {
    // Bull Board, metrics and health internals live on internal ports only.
    for (const path of ['/api/queues', '/metrics', '/api/v1/metrics', '/health/ready']) {
      const res = await request.get(path);
      const body = await res.text();
      expect(body).not.toMatch(/bull-board|process_cpu_seconds_total|"checks"/);
    }
  });

  test('browser error reports accept no content', async ({ request }) => {
    const res = await request.post('/api/v1/telemetry/client-errors', {
      data: { kind: 'render_error', name: 'Error', path: '/app', message: 'synthetic detail' },
    });
    expect(res.status()).toBe(400);
  });
});
