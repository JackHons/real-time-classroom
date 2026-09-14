import { defineConfig, devices } from '@playwright/test';
import { firefox } from '@playwright/test';
import { existsSync } from 'node:fs';
import { env } from 'node:process';

const firefoxAvailable = existsSync(firefox.executablePath());
const e2ePort = env.LAN_CLASSROOM_E2E_PORT ?? '4173';
const e2eOrigin = `http://127.0.0.1:${e2ePort}`;

if (!firefoxAvailable) {
  console.warn('Firefox is not installed for Playwright. Run: pnpm exec playwright install firefox');
}

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: env.PLAYWRIGHT_BASE_URL ?? e2eOrigin,
    trace: 'retain-on-failure'
  },
  webServer: env.PLAYWRIGHT_BASE_URL === undefined ? {
    command: 'pnpm build && node scripts/e2e-server.mjs',
    url: `${e2eOrigin}/health`,
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
