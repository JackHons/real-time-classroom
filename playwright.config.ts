import { defineConfig, devices } from '@playwright/test';
import { env } from 'node:process';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  use: {
    baseURL: env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4173'
  },
  projects: [
    { name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome' } },
    { name: 'edge', use: { ...devices['Desktop Edge'], channel: 'msedge' } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } }
  ]
});
