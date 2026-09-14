import { expect, test } from '@playwright/test';
import { expectAxeClean, expectMinimumTarget, expectNoHorizontalOverflow } from './a11y.js';

const password = 'E2E-accessible-password-1!';

test.describe('teacher management UI (real server)', () => {
  test('teacher can sign in and view the joined-student dashboard @a11y', async ({ page }) => {
    await page.goto('/teacher');
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByLabel('教師密碼')).toBeVisible();
    await expectAxeClean(page);

    await page.getByLabel('教師密碼').fill(password);
    await page.getByRole('button', { name: '登入', exact: true }).click();
    await page.waitForURL('**/teacher');
    await expect(page.getByRole('heading', { name: '教師管理' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: '教師功能' })).toBeVisible();
    await page.getByRole('navigation', { name: '教師功能' }).getByRole('link', { name: '班級與已加入學生', exact: true }).click();
    await page.waitForURL('**/teacher/roster');
    await expect(page.getByRole('heading', { name: /已加入學生/ })).toBeVisible();
    await expect(page.getByText('不需要預先匯入名單。')).toBeVisible();
    await expectMinimumTarget(page, '重新整理');
    await expectAxeClean(page);

    await page.getByRole('button', { name: '更新名單', exact: true }).focus();
    await expect(page.getByRole('button', { name: '更新名單', exact: true })).toBeFocused();
  });

  test('teacher interface preserves keyboard focus, reflow, reduced motion, and forced-colors readability @a11y', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
    await page.goto('/teacher');
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
