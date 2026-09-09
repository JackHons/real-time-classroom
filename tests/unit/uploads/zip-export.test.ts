import { randomUUID, createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { UploadStorage } from '../../../apps/server/src/uploads/storage.js';
import { exportZip } from '../../../apps/server/src/uploads/zip-export.js';

describe('ZIP export', () => {
  it('streams flat, server-generated names and suffixes case-insensitive collisions', async () => {
    await withStorage(async (storage) => {
      const first = await source(storage, 'one'); const second = await source(storage, 'two');
      const output = new PassThrough() as PassThrough & { writeHead: ReturnType<typeof vi.fn> };
      output.writeHead = vi.fn(); const chunks: Buffer[] = []; output.on('data', (chunk: Buffer) => chunks.push(chunk));
      const done = new Promise<void>((resolve) => output.on('end', resolve));
      await exportZip(output as never, storage, [
        entry(first, 'S-1', 'A/B', 'report.TXT'),
        entry(second, 's-1', 'a\\b', 'REPORT.txt')
      ]);
      await done;
      const archive = Buffer.concat(chunks).toString('utf8');
      expect(archive).toContain('S-1_A_B_report.TXT');
      expect(archive).toContain('s-1_a_b_REPORT.txt (2)');
      expect(archive).not.toContain('../');
      expect(output.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }));
    });
  });

  it('fails closed before headers when any final object is missing or corrupt', async () => {
    await withStorage(async (storage) => {
      const item = await source(storage, 'one');
      const output = new PassThrough() as PassThrough & { writeHead: ReturnType<typeof vi.fn> }; output.writeHead = vi.fn();
      await expect(exportZip(output as never, storage, [entry(item, '1', 'Name', 'file.txt', '0'.repeat(64))])).rejects.toThrow('FILE_EXPORT_INTEGRITY_FAILED');
      expect(output.writeHead).not.toHaveBeenCalled();
    });
  });

  it('allows the maximum fifty small streams without buffering their payloads', async () => {
    await withStorage(async (storage) => {
      const all = await Promise.all(Array.from({ length: 50 }, async (_, index) => entry(await source(storage, String(index)), String(index), 'Student', 'answer.bin')));
      const output = new PassThrough() as PassThrough & { writeHead: ReturnType<typeof vi.fn> }; output.writeHead = vi.fn(); output.resume();
      await exportZip(output as never, storage, all);
      expect(output.writeHead).toHaveBeenCalledTimes(1);
    });
  });

  it('releases its stream slot when the HTTP receiver aborts mid-archive', async () => {
    await withStorage(async (storage) => {
      const item = await source(storage, 'x'.repeat(128 * 1024));
      const aborted = new PassThrough() as PassThrough & { writeHead: ReturnType<typeof vi.fn> }; aborted.writeHead = vi.fn();
      const exportWhileBlocked = exportZip(aborted as never, storage, [entry(item, '1', 'Name', 'answer.bin')]);
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
      aborted.destroy();
      await expect(exportWhileBlocked).rejects.toThrow('FILE_EXPORT_ABORTED');
      const retry = new PassThrough() as PassThrough & { writeHead: ReturnType<typeof vi.fn> }; retry.writeHead = vi.fn(); retry.resume();
      await expect(exportZip(retry as never, storage, [entry(item, '1', 'Name', 'answer.bin')])).resolves.toBeUndefined();
    });
  });
});

async function withStorage(work: (storage: UploadStorage) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'zip-export-'));
  try { await work(new UploadStorage(root, { minimumFreeBytes: 0 })); } finally { await rm(root, { recursive: true, force: true }); }
}
async function source(storage: UploadStorage, content: string): Promise<Readonly<{ key: string; bytes: number; sha256: string }>> {
  await storage.ensureReady(); const key = randomUUID(); const bytes = Buffer.from(content);
  await writeFile(storage.finalPath(key), bytes);
  return { key, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
function entry(sourceValue: Readonly<{ key: string; bytes: number; sha256: string }>, number: string, name: string, filename: string, sha256 = sourceValue.sha256) {
  return { studentId: randomUUID() as never, studentNumber: number, displayName: name, originalFilename: filename, storageKey: sourceValue.key, byteLength: sourceValue.bytes, sha256 };
}
