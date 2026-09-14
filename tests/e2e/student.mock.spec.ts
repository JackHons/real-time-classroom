import { expect, test } from '@playwright/test';

/** Error and independent-pagination paths are intentionally deterministic client contracts. */
test.describe('student interface (mocked edge contracts)', () => {
  test('keeps the active view usable when activity polling fails', async ({ page }) => {
    await page.route('**/api/auth/session', (route) => route.fulfill({ contentType: 'application/json', body: '{"actor":"student","classId":"class-1","sessionId":"session-a"}' }));
    await page.route('**/api/auth/student/csrf', (route) => route.fulfill({ contentType: 'application/json', body: '{"csrfToken":"mock"}' }));
    await page.route('**/api/student/activities', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"TEMPORARY"}' }));
    await page.goto('/student');
    await page.waitForURL('**/student/activities');
    await expect(page.getByRole('heading', { name: '目前活動' })).toBeVisible();
    await expect(page.getByText('活動清單暫時無法更新，請檢查網路後重新整理。')).toBeVisible();
    await expect(page.getByRole('button', { name: '重新整理' })).toBeEnabled();
  });

  test('loads question and file-task pages independently when one cursor finishes first', async ({ page }) => {
    const activityQueries: Array<{ question: string | null; task: string | null }> = [];
    await page.route('**/api/auth/session', (route) => route.fulfill({ contentType: 'application/json', body: '{"actor":"student","classId":"class-1","sessionId":"session-a"}' }));
    await page.route('**/api/auth/student/csrf', (route) => route.fulfill({ contentType: 'application/json', body: '{"csrfToken":"mock"}' }));
    await page.route('**/api/student/activities**', (route) => {
      const url = new URL(route.request().url()); const question = url.searchParams.get('questionCursor'); const task = url.searchParams.get('fileTaskCursor'); activityQueries.push({ question, task });
      if (question === null && task === null) return route.fulfill({ json: { questions: { items: [{ id: 'q1', prompt: '題目一', kind: 'short_text', state: 'open' }], nextCursor: 'q2' }, fileTasks: { items: [{ id: 'f1', title: '作業一', description: '', state: 'open', deadlineAtUtc: '' }], nextCursor: 'f2' }, materials: { items: [] } } });
      if (question === 'q2' && task === 'f2') return route.fulfill({ json: { questions: { items: [{ id: 'q2', prompt: '題目二', kind: 'short_text', state: 'open' }] }, fileTasks: { items: [{ id: 'f2', title: '作業二', description: '', state: 'open', deadlineAtUtc: '' }], nextCursor: 'f3' }, materials: { items: [] } } });
      return route.fulfill({ json: { questions: { items: [{ id: 'q2-repeat', prompt: '不應附加', kind: 'short_text', state: 'open' }] }, fileTasks: { items: [{ id: 'f3', title: '作業三', description: '', state: 'open', deadlineAtUtc: '' }] }, materials: { items: [] } } });
    });
    await page.goto('/student');
    await page.waitForURL('**/student/activities');
    await expect(page.getByText('題目一')).toBeVisible();
    await page.getByRole('button', { name: '載入更多活動' }).click();
    await expect(page.getByText('題目二')).toBeVisible();
    await page.getByRole('button', { name: '載入更多活動' }).click();
    await expect(page.getByText('作業三')).toBeVisible();
    await expect(page.getByText('不應附加')).toHaveCount(0);
    expect(activityQueries).toEqual([{ question: null, task: null }, { question: 'q2', task: 'f2' }, { question: null, task: 'f3' }]);
  });

  test('stops the active view and reports session expiry on an authenticated API response', async ({ page }) => {
    let calls = 0;
    await page.route('**/api/auth/session', (route) => route.fulfill({ contentType: 'application/json', body: '{"actor":"student","classId":"class-1","sessionId":"session-a"}' }));
    await page.route('**/api/auth/student/csrf', (route) => route.fulfill({ contentType: 'application/json', body: '{"csrfToken":"mock"}' }));
    await page.route('**/api/student/activities', (route) => route.fulfill(calls++ === 0 ? { json: { questions: { items: [] }, fileTasks: { items: [] } } } : { status: 401, json: { error: 'UNAUTHENTICATED' } }));
    await page.goto('/student');
    await page.waitForURL('**/student/activities');
    await page.getByRole('button', { name: '重新整理' }).click();
    await expect(page.getByRole('status')).toContainText('登入已失效');
    await expect(page.getByRole('heading', { name: '目前活動' })).toHaveCount(0);
  });
});
