import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import type { FileStorageDeletion, FileStoragePort } from '../file-tasks/types.js';

const UUID_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STAGING_KEY = /^staging\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.part$/;

/** A single root makes staging-to-final rename an atomic same-filesystem move. */
export class UploadStorage implements FileStoragePort {
  private readonly root: string;
  private readonly stagingRoot: string;
  private readonly finalRoot: string;
  private readonly deletingRoot: string;

  constructor(root: string) {
    this.root = resolve(root);
    this.stagingRoot = resolve(this.root, 'staging');
    this.finalRoot = resolve(this.root, 'files');
    this.deletingRoot = resolve(this.root, 'deleting');
  }

  /** Exposed for bootstrap configuration and integration tests, not user input. */
  get rootPath(): string { return this.root; }

  async ensureReady(): Promise<void> { await Promise.all([mkdir(this.stagingRoot, { recursive: true }), mkdir(this.finalRoot, { recursive: true }), mkdir(this.deletingRoot, { recursive: true })]); }
  stagingKey(id: string): string { return `staging/${id}.part`; }
  stagingPath(key: string): string { return this.resolveKey(key, STAGING_KEY, this.stagingRoot, '.part'); }
  finalPath(key: string): string { return this.resolveKey(key, UUID_KEY, this.finalRoot, ''); }
  async openExclusiveStaging(key: string) { await this.ensureReady(); return open(this.stagingPath(key), 'wx', 0o600); }
  async renameStagingToFinal(stagingKey: string, finalKey: string): Promise<void> { await rename(this.stagingPath(stagingKey), this.finalPath(finalKey)); }
  async removeStaging(key: string | null): Promise<void> { if (key !== null) await rm(this.stagingPath(key), { force: true }); }
  async existsFinal(key: string): Promise<boolean> { try { return (await stat(this.finalPath(key))).isFile(); } catch { return false; } }
  async existsStaging(key: string): Promise<boolean> { try { return (await stat(this.stagingPath(key))).isFile(); } catch { return false; } }

  /**
   * Metadata deletion is coordinated by FileTaskService.  Move the opaque file
   * out of its readable location before the DB is marked deleted; a failed DB
   * write can therefore restore the exact same file by rename.  A one-file
   * commit removes the private tombstone only after the metadata write worked.
   */
  stageDeletion(entries: readonly Readonly<{ storageKey: string; submissionId: string }>[]): FileStorageDeletion {
    mkdirSync(this.deletingRoot, { recursive: true });
    const moved: Array<Readonly<{ from: string; tombstone: string }>> = [];
    try {
      for (const entry of entries) {
        const from = this.finalPath(entry.storageKey);
        const tombstone = resolve(this.deletingRoot, `${safeDeletionName(entry.submissionId)}-${entry.storageKey}`);
        if (!tombstone.startsWith(`${this.deletingRoot}${sep}`)) throw new Error('INVALID_STORAGE_KEY');
        renameSync(from, tombstone);
        moved.push({ from, tombstone });
      }
    } catch (error) {
      for (const item of moved.reverse()) { try { renameSync(item.tombstone, item.from); } catch { /* surface original staging error */ } }
      throw error;
    }
    let completed = false;
    return {
      commit: () => {
        if (completed) return;
        // FileTaskService currently deletes one submission at a time.  Keeping
        // this operation singular avoids a partial multi-file erase that could
        // not be rolled back after a filesystem error.
        if (moved.length !== 1) throw new Error('BATCH_DELETION_NOT_SUPPORTED');
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

  /** Re-reads a surviving staged file incrementally before restart recovery moves it. */
  async verifyStaging(key: string, expectedBytes: number, expectedSha256: string): Promise<boolean> {
    const hash = createHash('sha256'); let count = 0;
    for await (const chunk of createReadStream(this.stagingPath(key))) { count += chunk.length; hash.update(chunk); }
    return count === expectedBytes && hash.digest('hex') === expectedSha256;
  }

  private resolveKey(key: string, pattern: RegExp, directory: string, suffix: string): string {
    if (!pattern.test(key)) throw new Error('INVALID_STORAGE_KEY');
    const leaf = suffix === '' ? key : key.slice('staging/'.length);
    if (basename(leaf) !== leaf) throw new Error('INVALID_STORAGE_KEY');
    const path = resolve(directory, leaf);
    if (!path.startsWith(`${directory}${sep}`)) throw new Error('INVALID_STORAGE_KEY');
    return path;
  }
}

function safeDeletionName(value: string): string {
  if (!UUID_KEY.test(value)) throw new Error('INVALID_SUBMISSION_ID');
  return value;
}
