import { randomUUID, createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { UploadStorage } from '../../../apps/server/src/uploads/storage.js';
import { exportZip, zipBinary } from '../../../apps/server/src/uploads/zip-export.js';

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

  it('removes invisible/path/device syntax and folds Unicode filename collisions deterministically', async () => {
    await withStorage(async (storage) => {
      const first = await source(storage, 'one'); const second = await source(storage, 'two'); const third = await source(storage, 'three');
      const output = collectedResponse();
      await exportZip(output.response as never, storage, [
        entry(first, 'S-1', 'Straße', 'answer.txt'),
        entry(second, 's-1', 'STRASSE', 'ANSWER.TXT'),
        entry(third, 'C:\\..\\CON. ', '\u202EStraße/..', '\\server\\LPT1.txt ')
      ]);
      const names = centralNames(Buffer.concat(output.chunks));
      expect(names).toHaveLength(3);
      expect(names[2]).not.toMatch(/[\\/\u202e\p{Cc}]/u);
      expect(names[2]).not.toMatch(/^\.|[. ]$/u);
      expect(names[1]).toMatch(/ \(2\)$/);
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

  it('encodes Zip64 offsets, directory locator and EOCD for the 50 × 100 MB limit without allocating 5 GB', () => {
    const centralOffset = 4_900_000_000;
    const central = Buffer.from(zipBinary.centralHeader({ name: Buffer.from('50.bin'), bytes: 100_000_000, crc: 0, offset: 4_800_000_000 }));
    const ending = Buffer.from(zipBinary.endRecords(50, central.length * 50, centralOffset, centralOffset + central.length * 50));
    const parsed = parseZip64Directory(Buffer.concat([central, ending]));
    expect(parsed).toEqual({ entries: 50n, centralOffset: BigInt(centralOffset), zip64RecordOffset: BigInt(centralOffset + central.length * 50) });
    expect(central.readUInt32LE(42)).toBe(0xffffffff);
    expect(central.readBigUInt64LE(56)).toBe(4_800_000_000n);
  });

  it('rejects a same-size replacement with a different digest before headers', async () => {
    await withStorage(async (storage) => {
      const item = await source(storage, 'first');
      await writeFile(storage.finalPath(item.key), 'other');
      const output = collectedResponse();
      await expect(exportZip(output.response as never, storage, [entry(item, '1', 'Name', 'answer.bin')])).rejects.toThrow('FILE_EXPORT_INTEGRITY_FAILED');
      expect(output.response.writeHead).not.toHaveBeenCalled();
    });
  });

  it('aborts the archive when a pinned file changes after preflight verification', async () => {
    await withStorage(async (storage) => {
      const item = await source(storage, 'a'.repeat(128 * 1024));
      const output = collectedResponse(); let changed = false;
      output.response.on('error', () => undefined);
      const normalWrite = output.response.write.bind(output.response);
      output.response.write = ((chunk: Uint8Array) => {
        if (!changed && Buffer.from(chunk).readUInt32LE(0) === 0x04034b50) {
          changed = true; writeFileSync(storage.finalPath(item.key), 'b'.repeat(item.bytes));
        }
        return normalWrite(chunk);
      }) as typeof output.response.write;
      await expect(exportZip(output.response as never, storage, [entry(item, '1', 'Name', 'answer.bin')])).rejects.toThrow('FILE_EXPORT_INTEGRITY_FAILED');
      expect(changed).toBe(true);
      expect(output.response.destroyed).toBe(true);
    });
  });

  it('rejects a final-file symlink rather than following it', async () => {
    await withStorage(async (storage) => {
      const item = await source(storage, 'safe'); const target = join(storage.rootPath, 'outside');
      await writeFile(target, 'safe'); await rm(storage.finalPath(item.key));
      try { await symlink(target, storage.finalPath(item.key), 'file'); }
      catch (error: unknown) {
        // Some locked-down Windows runners deny creating symlinks. The export
        // path remains covered on systems where the attack primitive exists.
        if ((error as { code?: string }).code === 'EPERM') return;
        throw error;
      }
      const output = collectedResponse();
      await expect(exportZip(output.response as never, storage, [entry(item, '1', 'Name', 'answer.bin')])).rejects.toThrow('FILE_EXPORT_INTEGRITY_FAILED');
      expect(output.response.writeHead).not.toHaveBeenCalled();
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

function collectedResponse() {
  const response = new PassThrough() as PassThrough & { writeHead: ReturnType<typeof vi.fn> };
  response.writeHead = vi.fn(); const chunks: Buffer[] = []; response.on('data', (chunk: Buffer) => chunks.push(chunk));
  return { response, chunks };
}
function centralNames(archive: Buffer): readonly string[] {
  const names: string[] = []; let offset = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  while (offset >= 0 && archive.readUInt32LE(offset) === 0x02014b50) {
    const nameLength = archive.readUInt16LE(offset + 28); const extraLength = archive.readUInt16LE(offset + 30); const commentLength = archive.readUInt16LE(offset + 32);
    names.push(archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}
function parseZip64Directory(archive: Buffer): Readonly<{ entries: bigint; centralOffset: bigint; zip64RecordOffset: bigint }> {
  const zip64 = archive.indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x06])); const locator = archive.indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x07])); const eocd = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(zip64).toBeGreaterThanOrEqual(0); expect(locator).toBe(zip64 + 56); expect(eocd).toBe(locator + 20);
  expect(archive.readUInt16LE(eocd + 8)).toBe(0xffff); expect(archive.readUInt32LE(eocd + 12)).toBe(0xffffffff);
  return { entries: archive.readBigUInt64LE(zip64 + 32), centralOffset: archive.readBigUInt64LE(zip64 + 48), zip64RecordOffset: archive.readBigUInt64LE(locator + 8) };
}

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
