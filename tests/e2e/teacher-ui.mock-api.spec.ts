import { expect, test } from '@playwright/test';

/**
 * Mock-API UI contract tests. They exercise the Svelte teacher workflow and
 * keyboard/a11y structure; a browser run against the real authenticated
 * server remains an integration test because it needs a provisioned password.
 */
test.describe('teacher management UI (mock API)', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/health', (route) => route.fulfill({ json: { status: 'ok' } }));
    await page.route('**/api/auth/teacher/login', (route) => route.fulfill({ json: { actor: 'teacher', csrfToken: 'mock-csrf' } }));
    await page.route('**/api/classes', async (route) => {
      if (route.request().method() === 'GET') await route.fulfill({ json: [{ id: 'class-1', name: '一甲', createdAtUtc: '2026-01-01T00:00:00Z', updatedAtUtc: '2026-01-01T00:00:00Z' }] });
      else await route.fulfill({ status: 201, json: { id: 'class-2', name: '二甲', createdAtUtc: '2026-01-01T00:00:00Z', updatedAtUtc: '2026-01-01T00:00:00Z' } });
    });
    await page.route('**/api/question-templates', (route) => route.fulfill({ json: [] }));
    await page.route('**/api/classes/class-1/roster/preview', (route) => route.fulfill({ json: { rows: [{ displayName: '王小明', rawStudentNumber: 'S1', normalizedStudentNumber: 'S1' }], issues: [] } }));
  });

  test('teacher logs in, previews a roster, and must confirm a destructive action', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('教師密碼').fill('correct');
    await page.getByRole('button', { name: '登入' }).click();
    await expect(page.getByRole('heading', { name: '教師管理' })).toBeVisible();
    await page.getByLabel('CSV 內容').fill('姓名,學號\n王小明,S1');
    await page.getByRole('button', { name: '預覽' }).click();
    await expect(page.getByText('資料格式正確，共 1 筆。')).toBeVisible();
    await page.getByRole('button', { name: '刪除班級' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await expect(page.getByRole('button', { name: '刪除班級' })).toBeFocused();
  });

  test('@a11y login and teacher controls have landmarks, labels, and adequate target sizing', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByLabel('教師密碼')).toBeVisible();
    await page.getByLabel('教師密碼').fill('correct');
    await page.getByRole('button', { name: '登入' }).click();
    await expect(page.getByRole('navigation', { name: '教師功能' })).toBeVisible();
    for (const label of ['班級名稱', '選擇班級', 'CSV 內容', '題目', '檔案作業 ID']) await expect(page.getByLabel(label, { exact: true })).toBeVisible();
    const box = await page.getByRole('button', { name: '重新整理班級' }).boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
  });
});
