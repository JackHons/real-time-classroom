import { expect, test } from '@playwright/test';

/** Browser-only contract tests: every network response below is mocked, not a server E2E claim. */
test.describe('student interface (mocked API)', () => {
  test('joins a selected class and gets the active-session message', async ({ page }) => {
    await page.route('**/api/auth/session', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"UNAUTHENTICATED"}' }));
    await page.route('**/api/classes', (route) => route.fulfill({ contentType: 'application/json', body: '[{"id":"class-1","name":"數學課"}]' }));
    await page.route('**/api/classes/class-1/join', (route) => route.fulfill({ contentType: 'application/json', body: '{"outcome":"matched"}' }));
    await page.route('**/api/auth/student/join', (route) => route.fulfill({ contentType: 'application/json', body: '{"actor":"student","csrfToken":"test-token"}' }));
    await page.route('**/api/student/activities', (route) => route.fulfill({ contentType: 'application/json', body: '{"questions":[],"fileTasks":[]}' }));
    await page.goto('/student');
    await page.getByRole('combobox', { name: '課堂' }).selectOption('class-1');
    await page.getByLabel('姓名').fill('王小明');
    await page.getByLabel('學號').fill('S001');
    await page.getByRole('button', { name: '加入課堂' }).click();
    await expect(page.getByRole('status')).toContainText('已加入課堂');
  });

  test('has labelled controls and visible keyboard focus @a11y', async ({ page }) => {
    await page.route('**/api/auth/session', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }));
    await page.route('**/api/classes', (route) => route.fulfill({ contentType: 'application/json', body: '[{"id":"class-1","name":"數學課"}]' }));
    await page.goto('/student');
    await expect(page.getByLabel('課堂')).toBeVisible();
    await expect(page.getByLabel('姓名')).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.locator(':focus')).toBeVisible();
  });
});
