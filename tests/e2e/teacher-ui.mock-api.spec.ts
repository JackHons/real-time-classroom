import { expect, test } from '@playwright/test';

/** Focused client error/transition contracts; real-server coverage is in teacher-ui.spec.ts. */
test.describe('teacher management UI (mock API contracts)', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/health', (route) => route.fulfill({ json: { status: 'ok' } }));
    await page.route('**/api/auth/teacher/login', (route) => route.fulfill({ json: { actor: 'teacher', csrfToken: 'mock-csrf' } }));
    await page.route('**/api/teacher/classes', async (route) => {
      if (route.request().method() === 'GET') await route.fulfill({ json: { items: [{ id: 'class-1', name: '一甲', createdAtUtc: '2026-01-01T00:00:00Z', updatedAtUtc: '2026-01-01T00:00:00Z' }] } });
      else await route.fulfill({ status: 201, json: { id: 'class-2', name: '二甲', createdAtUtc: '2026-01-01T00:00:00Z', updatedAtUtc: '2026-01-01T00:00:00Z' } });
    });
    await page.route('**/api/teacher/classes/class-1/**', (route) => route.fulfill({ json: { items: [] } }));
    await page.route('**/api/question-templates', (route) => route.fulfill({ json: [] }));
    await page.route('**/api/classes/class-1/roster/preview', (route) => route.fulfill({ json: { rows: [{ displayName: '王小明', rawStudentNumber: 'S1', normalizedStudentNumber: 'S1' }], issues: [] } }));
  });

  test('retains the close-question cancellation contract', async ({ page }) => {
    await page.route('**/api/teacher/classes/class-1/questions', (route) => route.fulfill({ json: { items: [{ id: 'question-1', classId: 'class-1', kind: 'single_choice', prompt: '確認收答', state: 'open' }] } }));
    await page.goto('/');
    await page.getByLabel('教師密碼').fill('correct');
    await page.getByRole('button', { name: '登入' }).click();
    await page.getByLabel('選擇題目').selectOption('question-1');
    await page.getByRole('button', { name: '關閉題目' }).click();
    await expect(page.getByRole('dialog')).toContainText('關閉即時題');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: '關閉題目' })).toBeFocused();
  });
});
