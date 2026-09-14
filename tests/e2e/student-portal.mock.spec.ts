import { expect, test } from '@playwright/test';

test('student portal uses dedicated join, activities, question and assignment pages', async ({ page }) => {
  await page.route('**/api/auth/session', (route) => route.fulfill({ contentType: 'application/json', body: '{"actor":"student","classId":"class-1","sessionId":"session-a"}' }));
  await page.route('**/api/auth/student/csrf', (route) => route.fulfill({ contentType: 'application/json', body: '{"csrfToken":"mock"}' }));
  await page.route('**/api/student/activities', (route) => route.fulfill({ json: {
    questions: { items: [{ id: 'q1', prompt: '今天的問題', kind: 'single_choice', state: 'open' }] },
    fileTasks: { items: [{ id: 't1', title: '第一份作業', description: '', state: 'open', deadlineAtUtc: '2027-01-01T00:00:00.000Z' }] }
  } }));
  await page.goto('/student');
  await page.waitForURL('**/student/activities');
  await expect(page.getByRole('heading', { name: '我的課堂' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '即時題' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '檔案作業' })).toBeVisible();
  await expect(page.getByRole('link', { name: /今天的問題/ })).toHaveAttribute('href', '/student/question/q1');
  await expect(page.getByRole('link', { name: /第一份作業/ })).toHaveAttribute('href', '/student/task/t1?class=class-1');
  await expect(page.getByRole('navigation', { name: '學生導覽' }).getByRole('link', { name: '加入課堂' })).toHaveAttribute('href', '/student');
});

test('student activity view returns to join page when no student session exists', async ({ page }) => {
  await page.route('**/api/auth/session', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"UNAUTHENTICATED"}' }));
  await page.goto('/student/activities');
  await page.waitForURL('**/student');
  await expect(page.getByRole('heading', { name: '加入課堂' })).toBeVisible();
});
