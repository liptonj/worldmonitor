// e2e/admin-portal.spec.ts
import { test, expect } from '@playwright/test';

test.describe('Admin Portal', () => {
  test('shows login form at /admin.html', async ({ page }) => {
    await page.goto('/admin.html');
    await expect(page.locator('#admin-email')).toBeVisible();
    await expect(page.locator('#admin-password')).toBeVisible();
    await expect(page.locator('#admin-login-btn')).toBeVisible();
  });

  test('shows error on invalid credentials', async ({ page }) => {
    await page.goto('/admin.html');
    await page.fill('#admin-email', 'notanadmin@example.com');
    await page.fill('#admin-password', 'wrongpassword');
    await page.click('#admin-login-btn');
    await expect(page.locator('#admin-login-error')).toBeVisible({
      timeout: 5000,
    });
    await expect(page.locator('#admin-login-error')).toContainText(
      'Invalid email or password',
    );
  });

  test('/api/admin/secrets returns 401 without token', async ({ request }) => {
    const res = await request.get('/api/admin/secrets');
    expect(res.status()).toBe(401);
  });

  test('/api/admin/feature-flags returns 401 without token', async ({
    request,
  }) => {
    const res = await request.get('/api/admin/feature-flags');
    expect(res.status()).toBe(401);
  });

  test('/api/admin/news-sources returns 401 without token', async ({
    request,
  }) => {
    const res = await request.get('/api/admin/news-sources');
    expect(res.status()).toBe(401);
  });

  test('/api/admin/app-keys returns 401 without token', async ({ request }) => {
    const res = await request.get('/api/admin/app-keys');
    expect(res.status()).toBe(401);
  });

  test('/api/admin/llm-prompts returns 401 without token', async ({
    request,
  }) => {
    const res = await request.get('/api/admin/llm-prompts');
    expect(res.status()).toBe(401);
  });
});
