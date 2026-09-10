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
    await expect(page.getByRole('heading', { name: '教師管理' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: '教師功能' })).toBeVisible();
    await page.getByLabel('CSV 內容').fill('姓名,學號\n王小明,S100');
    await page.getByRole('button', { name: '預覽', exact: true }).click();
    await expect(page.getByText('資料格式正確，共 1 筆。')).toBeVisible();
    await expectMinimumTarget(page, '重新整理班級');
    await expectAxeClean(page);

    const deleteButton = page.getByRole('button', { name: '刪除班級', exact: true });
    await deleteButton.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await expect(deleteButton).toBeFocused();
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
    await expect(page.getByRole('heading', { name: '教師管理' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});
