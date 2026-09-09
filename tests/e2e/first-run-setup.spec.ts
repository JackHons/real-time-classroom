import { expect, test } from '@playwright/test';

test('local teacher can complete the one-time setup flow', async ({ page }) => {
  await page.goto('/setup');
  await expect(page.getByRole('heading', { name: '設定教師共用密碼' })).toBeVisible();
  await page.getByLabel(/新密碼/).fill('Strong-passphrase-1!');
  await page.getByLabel(/再次確認密碼/).fill('Strong-passphrase-1!');
  await page.getByRole('button', { name: '完成設定' }).click();
  await expect(page.getByText('設定完成，請重新整理或重新啟動服務後登入。')).toBeVisible();
});
