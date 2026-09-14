import { expect, test } from '@playwright/test';

test('public root redirects to the student join page', async ({ page }) => {
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);
  await expect(page).toHaveURL(/\/student$/);
  await expect(page.getByRole('heading', { name: '加入課堂' })).toBeVisible();
});
