import { expect, test } from '@playwright/test';

/** Focused client error/transition contracts; real-server coverage is in teacher-ui.spec.ts. */
test.describe('teacher management UI (mock API contracts)', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/health', (route) => route.fulfill({ json: { status: 'ok' } }));
    await page.route('**/api/auth/teacher/login', (route) => route.fulfill({ json: { actor: 'teacher', csrfToken: 'mock-csrf' } }));
    await page.route('**/api/auth/session', (route) => route.fulfill({ json: { actor: 'teacher' } }));
    await page.route('**/api/auth/teacher/csrf', (route) => route.fulfill({ json: { csrfToken: 'mock-csrf' } }));
    await page.route('**/api/teacher/classes', async (route) => {
      if (route.request().method() === 'GET') await route.fulfill({ json: { items: [{ id: 'class-1', name: '一甲', createdAtUtc: '2026-01-01T00:00:00Z', updatedAtUtc: '2026-01-01T00:00:00Z' }] } });
      else await route.fulfill({ status: 201, json: { id: 'class-2', name: '二甲', createdAtUtc: '2026-01-01T00:00:00Z', updatedAtUtc: '2026-01-01T00:00:00Z' } });
    });
    await page.route('**/api/teacher/classes/class-1/**', (route) => route.fulfill({ json: { items: [] } }));
    await page.route('**/api/question-templates', (route) => route.fulfill({ json: [] }));
    await page.route('**/api/classes/class-1/roster/preview', (route) => route.fulfill({ json: { rows: [{ displayName: '王小明', rawStudentNumber: 'S1', normalizedStudentNumber: 'S1' }], issues: [] } }));
  });

  test('Save temp and Build draft give visible success feedback', async ({ page }) => {
    await page.route('**/api/teacher/classes/class-1/questions', (route) => route.fulfill({ json: { items: [{ id: 'question-1', classId: 'class-1', kind: 'single_choice', prompt: '確認收答', state: 'open' }] } }));
    await page.route('**/api/question-templates', (route) => route.fulfill({ status: 201, json: { id: 'template-1' } }));
    await page.route('**/api/classes/class-1/question-drafts', (route) => route.fulfill({ status: 201, json: { id: 'draft-1', classId: 'class-1', kind: 'single_choice', prompt: '測試題目', options: [], referenceAnswer: null, state: 'draft' } }));
    await page.goto('/teacher/questions');
    await page.getByRole('textbox', { name: '題目', exact: true }).fill('測試題目');
    await page.getByRole('button', { name: 'Save temp', exact: true }).click();
    await expect(page.getByText('已儲存暫存題目到題庫，可繼續修改或建立草稿。')).toBeVisible();
    await page.getByRole('button', { name: 'Build draft', exact: true }).click();
    await expect(page.getByText('已建立草稿；可讀取後開放給學生。')).toBeVisible();
  });
});
