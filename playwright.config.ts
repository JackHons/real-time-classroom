import { defineConfig, devices } from '@playwright/test';
import { firefox } from '@playwright/test';
import { existsSync } from 'node:fs';
import { env } from 'node:process';

const firefoxAvailable = existsSync(firefox.executablePath());

if (!firefoxAvailable) {
  console.warn('Firefox is not installed for Playwright. Run: pnpm exec playwright install firefox');
}

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4173',
    trace: 'retain-on-failure'
  },
  webServer: env.PLAYWRIGHT_BASE_URL === undefined ? {
    command: 'pnpm build && node scripts/e2e-server.mjs',
    url: 'http://127.0.0.1:4173/health',
    timeout: 120_000,
    reuseExistingServer: false
  } : undefined,
  projects: [
    { name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome' } },
    { name: 'edge', use: { ...devices['Desktop Edge'], channel: 'msedge' } },
    // A missing bundled Firefox is explicitly skipped rather than reported as
    // a pass; Chrome and Edge still exercise the same real server runtime.
    { name: 'firefox', testIgnore: firefoxAvailable ? undefined : '**/*', use: { ...devices['Desktop Firefox'] } }
  ]
});
