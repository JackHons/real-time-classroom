import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { basename, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';

const UUID_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STAGING_KEY = /^staging\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.part$/;

/** A single root makes staging-to-final rename an atomic same-filesystem move. */
export class UploadStorage {
  private readonly root: string;
  private readonly stagingRoot: string;
  private readonly finalRoot: string;

  constructor(root: string) {
    this.root = resolve(root);
    this.stagingRoot = resolve(this.root, 'staging');
    this.finalRoot = resolve(this.root, 'files');
  }

  /** Exposed for bootstrap configuration and integration tests, not user input. */
  get rootPath(): string { return this.root; }

  async ensureReady(): Promise<void> { await Promise.all([mkdir(this.stagingRoot, { recursive: true }), mkdir(this.finalRoot, { recursive: true })]); }
  stagingKey(id: string): string { return `staging/${id}.part`; }
  stagingPath(key: string): string { return this.resolveKey(key, STAGING_KEY, this.stagingRoot, '.part'); }
  finalPath(key: string): string { return this.resolveKey(key, UUID_KEY, this.finalRoot, ''); }
  async openExclusiveStaging(key: string) { await this.ensureReady(); return open(this.stagingPath(key), 'wx', 0o600); }
  async renameStagingToFinal(stagingKey: string, finalKey: string): Promise<void> { await rename(this.stagingPath(stagingKey), this.finalPath(finalKey)); }
  async removeStaging(key: string | null): Promise<void> { if (key !== null) await rm(this.stagingPath(key), { force: true }); }
  async existsFinal(key: string): Promise<boolean> { try { return (await stat(this.finalPath(key))).isFile(); } catch { return false; } }
  async existsStaging(key: string): Promise<boolean> { try { return (await stat(this.stagingPath(key))).isFile(); } catch { return false; } }

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
