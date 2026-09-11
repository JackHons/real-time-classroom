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
await cp(join(root, 'Start Classroom.cmd'), join(output, 'Start Classroom.cmd'));
await cp(join(root, 'Stop Classroom.cmd'), join(output, 'Stop Classroom.cmd'));

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
await writeFile(join(output, 'RELEASE-PREREQUISITES.md'), `# LAN 課堂平台發佈包\n\n此包不需要原始碼、pnpm 或 Visual Studio。請在 Windows 10/11 安裝 Node.js 22 或 24 LTS x64。\n\n## 最簡單的本機 Web GUI 用法\n\n解壓後，直接雙擊包根目錄的 \`Start Classroom.cmd\`。它會在背景啟動服務，等待就緒後自動開啟 \`http://127.0.0.1:50165/\`；首次使用會自動改開 \`/setup\`。再次雙擊只會開啟已在執行的同一個服務。\n\n要關閉時，雙擊 \`Stop Classroom.cmd\`。它先要求該發佈包記錄的服務正常關閉，只有失敗時才對已驗證身分的該服務採用有限的強制停止；不會停止其他 Node.js 程序，也不會刪除資料庫或上傳檔案。日誌位於 \`%LOCALAPPDATA%\\LanClassroomPlatform\\server.stdout.log\` 和 \`server.stderr.log\`。這個本機 Web GUI 模式不會建立或修改 Windows 防火牆規則。\n\n## 私有 LAN 模式\n\n若需讓學生在受信任的 Private LAN 使用，請改從本包根目錄執行 \`scripts\\windows\\Start-LanClassroom.ps1\` 並明確選擇網卡。包內已含 Windows x64 的 better-sqlite3 預建原生檔。啟動器會在啟動前進行 SQLite 開啟／WAL 寫入測試；失敗時會安全停止並顯示錯誤，請改用支援的 Node 22/24 x64 或取得相符發佈包，切勿在教師電腦上安裝編譯工具。\n`);
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
