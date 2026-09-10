/* global document, window */
import { expect, type Page } from '@playwright/test';
import axeSource from 'axe-core';

export async function expectAxeClean(page: Page): Promise<void> {
  // The real server uses a per-response CSP nonce. Give the test-only axe
  // script that same nonce so accessibility auditing verifies the protected
  // page rather than bypassing or weakening its production CSP.
  // Browsers deliberately hide CSP nonce attributes from getAttribute(); the
  // nonce IDL property is the supported way to reuse it in this test context.
  const nonce = await page.locator('script[nonce]').first().evaluate((script) => (script as unknown as { nonce: string }).nonce);
  if (nonce.length === 0) throw new Error('CSP_NONCE_MISSING');
  await page.evaluate(({ source, scriptNonce }) => {
    const script = document.createElement('script');
    script.nonce = scriptNonce;
    script.text = source;
    document.head.append(script);
  }, { source: axeSource.source, scriptNonce: nonce });
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
