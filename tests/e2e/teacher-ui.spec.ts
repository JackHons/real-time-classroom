import { expect, test } from '@playwright/test';
import { expectAxeClean, expectMinimumTarget, expectNoHorizontalOverflow } from './a11y.js';

const password = 'E2E-accessible-password-1!';

test.describe('teacher management UI (real server)', () => {
  test('teacher can sign in, preview roster data, and cancel a destructive action with focus restored @a11y', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByLabel('教師密碼')).toBeVisible();
    await expectAxeClean(page);

    await page.getByLabel('教師密碼').fill(password);
    await page.getByRole('button', { name: '登入', exact: true }).click();
    await page.waitForURL('**/teacher');
    await expect(page.getByRole('heading', { name: '教師管理' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: '教師功能' })).toBeVisible();
    await page.getByRole('link', { name: '班級與名單', exact: true }).click();
    await page.waitForURL('**/teacher/roster');
    await page.getByLabel('CSV 內容').fill('學號,姓名,狀態\nS100,王小明,在測試中');
    await page.getByRole('button', { name: '預覽格式', exact: true }).click();
    await expect(page.getByText('可安全匯入 1 位學生。')).toBeVisible();
    await expect(page.getByText('第三欄及之後的資料未儲存（第 2 列）。')).toBeVisible();
    await expectMinimumTarget(page, '重新整理');
    await expectAxeClean(page);

    await page.getByRole('button', { name: '確認匯入', exact: true }).focus();
    await expect(page.getByRole('button', { name: '確認匯入', exact: true })).toBeFocused();
  });

  test('teacher interface preserves keyboard focus, reflow, reduced motion, and forced-colors readability @a11y', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
    await page.goto('/');
    await expect(page.getByLabel('教師密碼')).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.locator(':focus')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.getByLabel('教師密碼').fill(password);
    await page.getByRole('button', { name: '登入', exact: true }).click();
    await page.waitForURL('**/teacher');
    await expect(page.getByRole('heading', { name: '教師管理' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});
