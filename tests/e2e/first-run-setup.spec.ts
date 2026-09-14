/* global process, setTimeout */
import { spawn, type ChildProcess } from 'node:child_process';
import { expect, test } from '@playwright/test';

// Keep this second isolated runtime separate from the main e2e server.  A
// caller may override it when another local test already uses the default.
const setupPort = process.env.LAN_CLASSROOM_SETUP_E2E_PORT ?? '4175';
const setupOrigin = `http://127.0.0.1:${setupPort}`;

test('local teacher can complete the one-time setup flow on an isolated real runtime', async ({ browser }) => {
  const server = spawn(process.execPath, ['scripts/e2e-server.mjs'], {
    cwd: process.cwd(), stdio: 'ignore', env: { ...process.env, LAN_CLASSROOM_E2E_MODE: 'setup', LAN_CLASSROOM_E2E_PORT: setupPort }
  });
  try {
    await waitForSetupServer(server);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${setupOrigin}/setup`);
    await expect(page.getByRole('heading', { name: '設定教師共用密碼' })).toBeVisible();
    await page.getByLabel(/新密碼/).fill('Strong-passphrase-1!');
    await page.getByLabel(/再次確認密碼/).fill('Strong-passphrase-1!');
    await page.getByRole('button', { name: '完成設定' }).click();
    await expect(page.getByText('設定完成，請重新整理或重新啟動服務後登入。')).toBeVisible();
    await context.close();
  } finally {
    if (server.exitCode === null) server.kill('SIGTERM');
  }
});

async function waitForSetupServer(server: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`isolated setup server exited with ${server.exitCode}`);
    try { await fetch(`${setupOrigin}/health`); return; } catch { /* continue until the listener is ready */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('isolated setup server did not become ready');
}
