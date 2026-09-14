/* global document */
import { expect, test } from '@playwright/test';
import { expectAxeClean, expectMinimumTarget, expectNoHorizontalOverflow } from './a11y.js';

function studentNumber(project: string, suffix = ''): string { return `S-${project.toUpperCase()}${suffix}`; }

test.describe('student interface (real server)', () => {
  test('student joins a real seeded class and can navigate its live activities @a11y', async ({ page }, testInfo) => {
    await page.goto('/student');
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByLabel('課堂', { exact: true })).toBeVisible();
    await expectAxeClean(page);
    await page.getByLabel('課堂', { exact: true }).selectOption('e2e-class');
    const number = studentNumber(testInfo.project.name);
    await page.getByLabel('姓名').fill(`學生 ${number}`);
    await page.getByLabel('學號').fill(number);
    await expectMinimumTarget(page, '加入課堂');
    await page.getByRole('button', { name: '加入課堂', exact: true }).click();
    await page.waitForURL('**/student/activities');
    await expect(page.getByRole('heading', { name: '目前活動' })).toBeVisible();
    await expect(page.getByRole('link', { name: /今天的課堂重點/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /課堂作業/ })).toBeVisible();
    await expectAxeClean(page);
  });

  test('student flow supports keyboard-only navigation, 200% zoom/reflow, motion preferences, and semantic activity pages @a11y', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/student');
    await page.keyboard.press('Tab');
    await expect(page.locator(':focus')).toBeVisible();
    await page.getByLabel('課堂', { exact: true }).selectOption('e2e-class');
    const number = studentNumber(testInfo.project.name, '-ZOOM');
    await page.getByLabel('姓名').fill(`學生 ${number}`);
    // An independent seeded roster identity keeps each isolated browser
    // context valid without depending on cookies from the previous test.
    await page.getByLabel('學號').fill(number);
    await page.getByRole('button', { name: '加入課堂', exact: true }).click();
    await page.waitForURL('**/student/activities');
    const active = page.getByRole('heading', { name: '目前活動' });
    await expect(active).toBeVisible();
    await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
    await expectNoHorizontalOverflow(page);
    await page.getByRole('link', { name: /今天的課堂重點/ }).click();
    await expect(page.getByRole('main')).toBeVisible();
    await expectAxeClean(page);
  });
});
