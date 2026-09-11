import { cp, lstat, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const output = join(root, 'release', `LAN Classroom ${packageJson.version}`);

// This is intentionally a replaceable generated directory, never a user
// runtime directory. Its location is fixed below the checkout as a guard.
if (!relative(join(root, 'release'), output) || relative(join(root, 'release'), output).startsWith('..')) throw new Error('RELEASE_OUTPUT_PATH_INVALID');
await rm(output, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
await mkdir(join(output, 'apps'), { recursive: true });

// A prior production deploy may have pruned build tooling. Restore the locked
// development graph first, then leave it restored after assembly as well.
await runPnpm(['install', '--frozen-lockfile']);
await runPnpm(['build']);
// Hoisted deploy gives a conventional physical node_modules tree. Unlike the
// default Windows junction layout, it survives a copy, zip, or new directory.
await deploy('@lan-classroom/server', join(output, 'apps', 'server'));
await deploy('@lan-classroom/web', join(output, 'apps', 'web'));
await cp(join(root, 'apps', 'server', 'dist'), join(output, 'apps', 'server', 'dist'), { recursive: true });
await cp(join(root, 'apps', 'web', 'build'), join(output, 'apps', 'web', 'build'), { recursive: true });
await rm(join(output, 'apps', 'server', 'src'), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
await rm(join(output, 'apps', 'web', 'src'), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
await rm(join(output, 'apps', 'server', 'tsconfig.json'), { force: true });
await rm(join(output, 'apps', 'web', 'tsconfig.json'), { force: true });
await cp(join(root, 'scripts', 'windows'), join(output, 'scripts', 'windows'), { recursive: true });
await cp(join(root, 'docs'), join(output, 'docs'), { recursive: true });
await cp(join(root, 'LICENSES'), join(output, 'LICENSES'), { recursive: true });
await cp(join(root, 'README.md'), join(output, 'README.md'));

const migrationDirectory = join(output, 'apps', 'server', 'dist', 'db', 'migrations');
const migrations = await Promise.all((await readdir(migrationDirectory)).filter((name) => name.endsWith('.sql')).sort().map(async (name) => ({
  name,
  sha256: createHash('sha256').update(await readFile(join(migrationDirectory, name))).digest('hex')
})));
if (migrations.length === 0) throw new Error('RELEASE_MIGRATIONS_MISSING');
const nativeArtifact = join(output, 'apps', 'server', 'node_modules', 'better-sqlite3', 'prebuilds', 'win32-x64.node');
if (!(await exists(nativeArtifact))) throw new Error('RELEASE_WINDOWS_SQLITE_PREBUILD_MISSING');
const clientDependency = join(output, 'apps', 'web', 'node_modules', 'socket.io-client', 'package.json');
if (!(await exists(clientDependency))) throw new Error('RELEASE_SOCKET_IO_CLIENT_MISSING');
await assertNoSymbolicLinks(output);
await writeFile(join(output, 'release-manifest.json'), `${JSON.stringify({
  format: 1,
  product: 'lan-classroom-platform',
  version: packageJson.version,
  node: '^22.0.0 || ^24.0.0',
  migrations,
  nativeArtifacts: ['apps/server/node_modules/better-sqlite3/prebuilds/win32-x64.node'],
  productionDependencies: { server: ['argon2', 'better-sqlite3', 'socket.io'], web: ['socket.io-client'] }
}, null, 2)}\n`);
await writeFile(join(output, 'RELEASE-PREREQUISITES.md'), `# LAN 課堂平台發佈包\n\n此包不需要原始碼、pnpm 或 Visual Studio。請在 Windows 10/11 安裝 Node.js 22 或 24 LTS x64，再從本包根目錄執行 \`scripts\\windows\\Start-LanClassroom.ps1\`。\n\n包內已含 Windows x64 的 better-sqlite3 預建原生檔。啟動器會在啟動前進行 SQLite 開啟／WAL 寫入測試；失敗時會安全停止並顯示錯誤，請改用支援的 Node 22/24 x64 或取得相符發佈包，切勿在教師電腦上安裝編譯工具。\n`);
console.log(output);
await runPnpm(['install', '--frozen-lockfile']);

async function exists(path) { try { return (await stat(path)).isFile(); } catch { return false; } }
async function deploy(filter, destination) {
  // Windows cannot CreateProcess a .cmd file directly.  All values here are
  // generated from this checked-in package metadata (not user input), and the
  // shell is only the documented cmd bridge to pnpm.cmd.
  runPnpm(['--filter', filter, 'deploy', '--legacy', '--prod', '--ignore-scripts', '--config.node-linker=hoisted', destination]);
}
function runPnpm(argumentsList) {
  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const options = { cwd: root, stdio: 'inherit', env: { ...process.env, CI: 'true' } };
  const result = process.platform === 'win32'
    ? spawnSync(`${command} ${argumentsList.map(quoteForCmd).join(' ')}`, { ...options, shell: true })
    : spawnSync(command, argumentsList, options);
  if (result.status !== 0) throw new Error(`RELEASE_PNPM_FAILED:${argumentsList[0]}`);
}
function quoteForCmd(value) { return `"${value.replaceAll('"', '""')}"`; }
async function assertNoSymbolicLinks(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`RELEASE_LINK_NOT_PORTABLE:${path}`);
  if (!info.isDirectory()) return;
  for (const entry of await readdir(path)) await assertNoSymbolicLinks(join(path, entry));
}
