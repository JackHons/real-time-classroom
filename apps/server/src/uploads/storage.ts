import { chmodSync, constants, lstatSync, renameSync, rmSync } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm, statfs } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { env as processEnvironment } from 'node:process';
import type { FileStorageDeletion, FileStoragePort } from '../file-tasks/types.js';

const UUID_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STAGING_KEY = /^staging\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.part$/;
const TOMBSTONE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.deleting$/;
const GiB = 1024 ** 3;
/** 5 GiB base capacity plus one maximum upload for staging and one for export/recovery. */
export const DEFAULT_MINIMUM_FREE_BYTES = 5 * GiB + 2 * 100_000_000;

export type DeletionTombstone = Readonly<{ submissionId: string; storageKey: string }>;
export type UploadStorageOptions = Readonly<{
  minimumFreeBytes?: number;
  /** Injection seam for deterministic capacity tests and monitored deployments. */
  freeSpaceBytes?: (root: string) => Promise<number>;
}>;

/** A single root makes staging-to-final rename an atomic same-filesystem move. */
export class UploadStorage implements FileStoragePort {
  private readonly root: string;
  private readonly stagingRoot: string;
  private readonly finalRoot: string;
  private readonly deletingRoot: string;
  private readonly minimumFreeBytes: number;
  private readonly freeSpaceBytes: (root: string) => Promise<number>;
  private preparing: Promise<void> | undefined;

  constructor(root: string, options: UploadStorageOptions = {}) {
    this.root = resolve(root);
    this.stagingRoot = resolve(this.root, 'staging');
    this.finalRoot = resolve(this.root, 'files');
    this.deletingRoot = resolve(this.root, 'deleting');
    this.minimumFreeBytes = options.minimumFreeBytes ?? DEFAULT_MINIMUM_FREE_BYTES;
    if (!Number.isSafeInteger(this.minimumFreeBytes) || this.minimumFreeBytes < 0) throw new Error('INVALID_STORAGE_FREE_SPACE_THRESHOLD');
    this.freeSpaceBytes = options.freeSpaceBytes ?? availableBytes;
  }

  /** Exposed for bootstrap configuration and integration tests, not user input. */
  get rootPath(): string { return this.root; }

  /** Fails closed for an unsafe/reparsed private root or an unavailable capacity probe. */
  async ensureReady(): Promise<void> {
    // Coalesce concurrent upload/export admission checks. A later independent
    // call still performs the complete ACL/reparse verification again.
    if (this.preparing !== undefined) return this.preparing;
    const work = this.ensureReadyDirect(); this.preparing = work;
    try { await work; } finally { if (this.preparing === work) this.preparing = undefined; }
  }

  private async ensureReadyDirect(): Promise<void> {
    // Never call chmod or mkdir through a pre-existing reparse point. Doing so
    // could repair permissions on an attacker-selected external directory.
    await assertAbsentOrPrivateDirectory(this.root);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const directory of [this.stagingRoot, this.finalRoot, this.deletingRoot]) {
      await assertAbsentOrPrivateDirectory(directory);
      await mkdir(directory, { recursive: true, mode: 0o700 });
    }
    // mkdir's mode is affected by umask and does not repair an existing
    // directory. Repair and then verify every dedicated child on each start.
    await Promise.all([this.root, this.stagingRoot, this.finalRoot, this.deletingRoot].map(securePrivateDirectory));
    await this.assertPrivateDirectories();
    let free: number;
    try { free = await this.freeSpaceBytes(this.root); } catch (error) { throw new Error('UPLOAD_STORAGE_PROBE_FAILED', { cause: error }); }
    if (!Number.isSafeInteger(free) || free < this.minimumFreeBytes) throw new Error('UPLOAD_STORAGE_INSUFFICIENT_SPACE');
    await this.writeProbe();
  }

  stagingKey(id: string): string { return `staging/${id}.part`; }
  stagingPath(key: string): string { return this.resolveKey(key, STAGING_KEY, this.stagingRoot, '.part'); }
  finalPath(key: string): string { return this.resolveKey(key, UUID_KEY, this.finalRoot, ''); }
  async openExclusiveStaging(key: string) { await this.ensureReady(); return open(this.stagingPath(key), 'wx', 0o600); }
  async renameStagingToFinal(stagingKey: string, finalKey: string): Promise<void> { await this.assertPrivateDirectories(); await rename(this.stagingPath(stagingKey), this.finalPath(finalKey)); }
  async removeStaging(key: string | null): Promise<void> { if (key !== null) { await this.assertPrivateDirectories(); await rm(this.stagingPath(key), { force: true }); } }
  async removeFinal(key: string): Promise<void> { await this.assertPrivateDirectories(); await rm(this.finalPath(key), { force: true }); }
  async existsFinal(key: string): Promise<boolean> { return isRegularFile(this.finalPath(key)); }

  /**
   * Opens a final object without following links and pins the exact filesystem
   * object that was inspected.  Callers must close the returned handle.
   *
   * Comparing the pre-open lstat with fstat closes the replacement window: a
   * file swapped between those operations is rejected instead of exported.
   * O_NOFOLLOW is also used where the platform supports it; the identity check
   * remains necessary because Windows does not expose that flag consistently.
   */
  async openVerifiedFinal(key: string): Promise<FileHandle> {
    await this.assertPrivateDirectories();
    return this.openVerifiedPath(this.finalPath(key));
  }

  private async openVerifiedPath(path: string): Promise<FileHandle> {
    let before: Awaited<ReturnType<typeof lstat>>;
    try { before = await lstat(path); } catch { throw new Error('FILE_EXPORT_INTEGRITY_FAILED'); }
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('FILE_EXPORT_INTEGRITY_FAILED');
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const after = await handle.stat();
      if (!after.isFile() || !sameFileIdentity(before, after)) throw new Error('FILE_EXPORT_INTEGRITY_FAILED');
      return handle;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (error instanceof Error && error.message === 'FILE_EXPORT_INTEGRITY_FAILED') throw error;
      throw new Error('FILE_EXPORT_INTEGRITY_FAILED', { cause: error });
    }
  }

  /** Hash before a privileged export.  A replaced, missing, linked, or corrupt
   * final object is never partially disclosed. */
  async verifyFinal(key: string, expectedBytes: number, expectedSha256: string): Promise<boolean> {
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || !/^[a-f0-9]{64}$/.test(expectedSha256)) return false;
    const hash = createHash('sha256'); let count = 0;
    let handle: FileHandle | undefined;
    try {
      handle = await this.openVerifiedFinal(key);
      for await (const chunk of handle.createReadStream({ autoClose: false })) { count += chunk.length; if (count > expectedBytes) return false; hash.update(chunk); }
    }
    catch { return false; }
    finally { await handle?.close().catch(() => undefined); }
    return count === expectedBytes && hash.digest('hex') === expectedSha256;
  }
  async existsStaging(key: string): Promise<boolean> { return isRegularFile(this.stagingPath(key)); }

  /**
   * A .deleting filename is itself a durable, payload-free deletion marker.
   * Its two UUIDs make crashes on either side of the metadata transaction
   * recoverable: a live DB row restores it; a soft-deleted row completes it.
   */
  stageDeletion(entries: readonly Readonly<{ storageKey: string; submissionId: string }>[]): FileStorageDeletion {
    this.assertPrivateDirectoriesSync();
    const moved: Array<Readonly<{ from: string; tombstone: string }>> = [];
    try {
      for (const entry of entries) {
        const from = this.finalPath(entry.storageKey);
        const tombstone = this.tombstonePath(entry.submissionId, entry.storageKey);
        renameSync(from, tombstone);
        moved.push({ from, tombstone });
      }
    } catch (error) {
      for (const item of moved.reverse()) { try { renameSync(item.tombstone, item.from); } catch { /* preserve original error */ } }
      throw error;
    }
    let completed = false;
    return {
      commit: () => {
        if (completed) return;
        if (moved.length !== 1) throw new Error('BATCH_DELETION_NOT_SUPPORTED');
        // Do not remove a failed tombstone: startup reconciliation needs it as
        // a durable witness and can either retry or restore it.
        rmSync(moved[0]!.tombstone);
        completed = true;
      },
      rollback: () => {
        if (completed) return;
        for (const item of moved.reverse()) renameSync(item.tombstone, item.from);
        completed = true;
      }
    };
  }

  async listDeletionTombstones(): Promise<readonly DeletionTombstone[]> {
    await this.assertPrivateDirectories();
    const entries = await readdir(this.deletingRoot, { withFileTypes: true });
    const result: DeletionTombstone[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) continue;
      const parsed = TOMBSTONE.exec(entry.name);
      if (parsed !== null) result.push({ submissionId: parsed[1]!, storageKey: parsed[2]! });
    }
    return result;
  }
  async restoreDeletionTombstone(entry: DeletionTombstone): Promise<void> { await this.assertPrivateDirectories(); await rename(this.tombstonePath(entry.submissionId, entry.storageKey), this.finalPath(entry.storageKey)); }
  async completeDeletionTombstone(entry: DeletionTombstone): Promise<void> { await this.assertPrivateDirectories(); await rm(this.tombstonePath(entry.submissionId, entry.storageKey), { force: false }); }

  /** Re-reads a surviving staged file incrementally before restart recovery moves it. */
  async verifyStaging(key: string, expectedBytes: number, expectedSha256: string): Promise<boolean> {
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || !/^[a-f0-9]{64}$/.test(expectedSha256)) return false;
    await this.assertPrivateDirectories();
    const hash = createHash('sha256'); let count = 0;
    let handle: FileHandle | undefined;
    try {
      // Recovery is privileged too: never follow a staged symlink or verify
      // one object then later move a replacement.
      handle = await this.openVerifiedPath(this.stagingPath(key));
      for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) {
        count += chunk.length;
        if (count > expectedBytes) return false;
        hash.update(chunk);
      }
      return count === expectedBytes && hash.digest('hex') === expectedSha256;
    } catch { return false; }
    finally { await handle?.close().catch(() => undefined); }
  }

  private tombstonePath(submissionId: string, storageKey: string): string {
    if (!UUID_KEY.test(submissionId) || !UUID_KEY.test(storageKey)) throw new Error('INVALID_STORAGE_KEY');
    return resolve(this.deletingRoot, `${submissionId}-${storageKey}.deleting`);
  }
  private resolveKey(key: string, pattern: RegExp, directory: string, suffix: string): string {
    if (!pattern.test(key)) throw new Error('INVALID_STORAGE_KEY');
    const leaf = suffix === '' ? key : key.slice('staging/'.length);
    if (basename(leaf) !== leaf) throw new Error('INVALID_STORAGE_KEY');
    const path = resolve(directory, leaf);
    if (!path.startsWith(`${directory}${sep}`)) throw new Error('INVALID_STORAGE_KEY');
    return path;
  }
  private async assertPrivateDirectories(): Promise<void> { await Promise.all([this.root, this.stagingRoot, this.finalRoot, this.deletingRoot].map(assertPrivateDirectory)); }
  private assertPrivateDirectoriesSync(): void { for (const path of [this.root, this.stagingRoot, this.finalRoot, this.deletingRoot]) assertPrivateDirectorySync(path); }
  private async writeProbe(): Promise<void> {
    const probe = resolve(this.stagingRoot, `.storage-probe-${randomUUID()}`);
    if (!probe.startsWith(`${this.stagingRoot}${sep}`)) throw new Error('UPLOAD_STORAGE_PATH_UNSAFE');
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(probe, 'wx', 0o600);
      await handle.write(new Uint8Array([0]));
      await handle.sync();
    } catch (error) {
      throw new Error('UPLOAD_STORAGE_WRITE_PROBE_FAILED', { cause: error });
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(probe, { force: true }).catch(() => undefined);
    }
  }
}

async function availableBytes(root: string): Promise<number> { const info = await statfs(root); return Number(info.bavail) * Number(info.bsize); }
async function isRegularFile(path: string): Promise<boolean> { try { return (await lstat(path)).isFile(); } catch { return false; } }
function sameFileIdentity(left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<FileHandle['stat']>>): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
async function assertPrivateDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (!isWindows() && (info.mode & 0o077) !== 0)) throw new Error('UPLOAD_STORAGE_PATH_UNSAFE');
}
async function assertAbsentOrPrivateDirectory(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('UPLOAD_STORAGE_PATH_UNSAFE');
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return;
    throw error;
  }
}
function assertPrivateDirectorySync(path: string): void {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (!isWindows() && (info.mode & 0o077) !== 0)) throw new Error('UPLOAD_STORAGE_PATH_UNSAFE');
}
async function securePrivateDirectory(path: string): Promise<void> {
  try { chmodSync(path, 0o700); } catch (error) { throw new Error('UPLOAD_STORAGE_PATH_UNSAFE', { cause: error }); }
  if (!isWindows()) return;
  try {
    const username = processEnvironment.USERNAME;
    if (username === undefined || username.length === 0) throw new Error('USERNAME_REQUIRED');
    execFileSync('icacls.exe', [path, '/inheritance:r', '/remove:g', '*S-1-1-0', '*S-1-5-11', '*S-1-5-32-545', '/grant:r', `${username}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'], { windowsHide: true, stdio: 'ignore' });
    execFileSync('icacls.exe', [path, '/verify'], { windowsHide: true, stdio: 'ignore' });
  } catch (error) { throw new Error('UPLOAD_STORAGE_PATH_UNSAFE', { cause: error }); }
}
function isWindows(): boolean { return processEnvironment.OS === 'Windows_NT'; }
function isErrorCode(error: unknown, code: string): boolean { return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code; }
