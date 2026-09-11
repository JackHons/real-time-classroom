/* global fetch, setTimeout */
import { mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const assembled = join(root, 'release', `LAN Classroom ${version}`);
const temporary = await mkdtemp(join(tmpdir(), 'lan-classroom-release-'));
// A non-ASCII, spaced directory outside the checkout prevents Node from
// accidentally resolving its modules from a source-tree parent node_modules.
const packageRoot = join(temporary, '課堂 平台 release');
let child;
const logs = [];
let moved = false;
try {
  // Moving (rather than copying) preserves pnpm's relative virtual-store
  // links and also proves this package starts outside the source tree.
  await rename(assembled, packageRoot); moved = true;
  const port = await freePort();
  const runtime = join(temporary, 'runtime');
  await mkdir(join(runtime, 'database'), { recursive: true });
  child = spawn(process.execPath, ['apps/server/dist/main.js'], {
    cwd: packageRoot,
    env: {
      ...process.env,
      LAN_CLASSROOM_HOST: '127.0.0.1',
      LAN_CLASSROOM_HOSTS: '127.0.0.1',
      LAN_CLASSROOM_PORT: String(port),
      LAN_CLASSROOM_ALLOWED_ORIGIN: `http://127.0.0.1:${port}`,
      LAN_CLASSROOM_CSRF_SECRET: 'release-verify-secret-must-be-at-least-32-bytes',
      LAN_CLASSROOM_DATABASE_PATH: join(runtime, 'database', 'classroom.sqlite'),
      LAN_CLASSROOM_UPLOAD_STORAGE_PATH: join(runtime, 'uploads-files'),
      LAN_CLASSROOM_SHUTDOWN_TOKEN: 'release-verify-shutdown-token'
    },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  child.stdout.on('data', (value) => logs.push(String(value))); child.stderr.on('data', (value) => logs.push(String(value)));
  await waitFor(`${`http://127.0.0.1:${port}`}/setup`);
  const ui = await fetch(`http://127.0.0.1:${port}/setup`);
  if (ui.status !== 200 || !((await ui.text()).includes('首次設定'))) throw new Error(`RELEASE_UI_NOT_READY:${ui.status}`);
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  if (health.status !== 503) throw new Error(`RELEASE_HEALTH_EXPECTED_SETUP:${health.status}`);
  child.kill('SIGTERM'); await exited(child);
  console.log(`release verification passed: ${packageRoot}`);
} catch (error) {
  throw new Error(`${error instanceof Error ? error.message : String(error)}\n${logs.join('')}`, { cause: error });
} finally {
  if (child !== undefined && child.exitCode === null) child.kill('SIGKILL');
  if (moved) await rename(packageRoot, assembled);
  await rm(temporary, { recursive: true, force: true });
}

function freePort() { return new Promise((resolvePort, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close((error) => error ? reject(error) : resolvePort(address.port)); }); }); }
async function waitFor(url) { for (let index = 0; index < 80; index += 1) { try { if ((await fetch(url)).status === 200) return; } catch { /* server is still starting */ } await new Promise((resolveDelay) => setTimeout(resolveDelay, 100)); } throw new Error(`RELEASE_START_TIMEOUT:${url}`); }
function exited(process) { return new Promise((resolveExit) => process.once('exit', () => resolveExit())); }
