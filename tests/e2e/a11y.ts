/* global document, window */
import { expect, type Page } from '@playwright/test';
import axeSource from 'axe-core';

export async function expectAxeClean(page: Page): Promise<void> {
  await page.addScriptTag({ content: axeSource.source });
  const results = await page.evaluate(async () => {
    const axe = (window as typeof window & { axe: { run: (context: unknown, options: object) => Promise<{ violations: unknown[] }> } }).axe;
    return axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] } });
  });
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
}

export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

export async function expectMinimumTarget(page: Page, name: string): Promise<void> {
  const box = await page.getByRole('button', { name, exact: true }).boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(44);
  expect(box?.width).toBeGreaterThanOrEqual(44);
}
