import type { FileHandle } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { TextEncoder } from 'node:util';
import type { FileExportSubmission } from '../file-tasks/types.js';
import type { UploadStorage } from './storage.js';

const MAX_EXPORT_FILES = 50;
const MAX_EXPORT_BYTES = 50 * 100_000_000;
const UTF8 = new TextEncoder();
const MAX_CONCURRENT_EXPORTS = 2;
const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffff;
let activeExports = 0;

type ZipEntry = Readonly<{ name: string; bytes: number; storageKey: string; sha256: string }>;
type PreparedEntry = ZipEntry & Readonly<{ handle: FileHandle }>;
type Central = Readonly<{ name: Uint8Array; bytes: number; crc: number; offset: number }>;

/** Stored (uncompressed) ZIP stream. It has bounded metadata and never holds
 * submission bytes in memory. Zip64 directory records permit the contractual
 * 50 × 100 MB archive even though individual submission files stay below 4 GB. */
export async function exportZip(response: ServerResponse, storage: UploadStorage, submissions: readonly FileExportSubmission[]): Promise<void> {
  return withExportSlot(async () => {
    if (submissions.length > MAX_EXPORT_FILES) throw new Error('FILE_EXPORT_LIMIT_EXCEEDED');
    const entries = makeEntries(submissions);
    const total = entries.reduce((sum, item) => sum + item.bytes, 0);
    if (!Number.isSafeInteger(total) || total > MAX_EXPORT_BYTES) throw new Error('FILE_EXPORT_LIMIT_EXCEEDED');
    await storage.ensureReady();

    // Pin each checked object before headers. This both fails closed for a
    // corrupt archive and prevents a lstat/open replacement race from leaking
    // a newly substituted path after preflight.
    const prepared: PreparedEntry[] = [];
    try {
      for (const entry of entries) {
        const handle = await storage.openVerifiedFinal(entry.storageKey);
        if (!await matchesExpected(handle, entry.bytes, entry.sha256)) {
          await handle.close();
          throw new Error('FILE_EXPORT_INTEGRITY_FAILED');
        }
        prepared.push({ ...entry, handle });
      }
    } catch (error) {
      await closePrepared(prepared);
      throw error;
    }

    response.writeHead(200, secureHeaders('submissions.zip'));
    let offset = 0;
    const central: Central[] = [];
    // A close can happen while the file iterator is waiting on disk rather
    // than only while write() is backpressured. Keep one explicit lifecycle
    // signal so every branch unwinds its pinned descriptors and export slot.
    let receiverClosed = response.destroyed;
    const receiverClose = () => { if (!response.writableEnded) receiverClosed = true; };
    response.once('close', receiverClose);
    try {
      for (const entry of prepared) {
        if (receiverClosed || response.destroyed) throw new Error('FILE_EXPORT_ABORTED');
        const name = UTF8.encode(entry.name);
        const localOffset = offset;
        const local = localHeader(name); offset += local.length;
        await write(response, local);
        let crc = 0xffffffff; let written = 0;
        const hash = createHash('sha256');
        for await (const chunk of entry.handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024, start: 0 })) {
          if (receiverClosed || response.destroyed) throw new Error('FILE_EXPORT_ABORTED');
          crc = crc32(chunk, crc); written += chunk.length; hash.update(chunk);
          await write(response, chunk); offset += chunk.length;
        }
        // The second digest catches modification of the object after preflight,
        // including same-size replacement or in-place writes.
        if (written !== entry.bytes || hash.digest('hex') !== entry.sha256) throw new Error('FILE_EXPORT_INTEGRITY_FAILED');
        crc = (crc ^ 0xffffffff) >>> 0;
        const descriptor = dataDescriptor(crc, written); offset += descriptor.length;
        await write(response, descriptor);
        central.push({ name, bytes: written, crc, offset: localOffset });
      }
      const centralOffset = offset;
      for (const item of central) { const record = centralHeader(item); offset += record.length; await write(response, record); }
      await write(response, endRecords(central.length, offset - centralOffset, centralOffset, offset));
      response.end();
    } catch (error) {
      // An aborted receiver or changed object must stop every handle immediately.
      // Do not emit filenames, paths, or database keys after ZIP has started.
      if (!response.destroyed) response.destroy(error instanceof Error ? error : undefined);
      throw error;
    } finally {
      response.off('close', receiverClose);
      await closePrepared(prepared);
    }
  });
}

/** Process-wide cap keeps a few slow archive readers from exhausting file
 * handles/disk while still allowing an independent teacher download. */
export async function withExportSlot<T>(work: () => Promise<T>): Promise<T> {
  if (activeExports >= MAX_CONCURRENT_EXPORTS) throw new Error('FILE_EXPORT_BUSY');
  activeExports += 1;
  try { return await work(); } finally { activeExports -= 1; }
}

export function secureHeaders(filename: string): Record<string, string> {
  return { 'cache-control': 'no-store', 'content-type': 'application/zip', 'content-disposition': attachmentDisposition(filename), 'x-content-type-options': 'nosniff' };
}
export function attachmentDisposition(filename: string): string {
  const fallback = filename.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'download';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function makeEntries(submissions: readonly FileExportSubmission[]): readonly ZipEntry[] {
  const seen = new Set<string>();
  return submissions.map((value, index) => {
    if (!Number.isSafeInteger(value.byteLength) || value.byteLength < 0 || value.byteLength > 100_000_000 || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error('FILE_EXPORT_INTEGRITY_FAILED');
    const base = `${safePart(value.studentNumber, 'student')}_${safePart(value.displayName, 'name')}_${safePart(value.originalFilename, 'file')}`.slice(0, 220);
    let name = base || `submission_${index + 1}`;
    let suffix = 2;
    while (seen.has(collisionKey(name))) { name = `${base.slice(0, 210)} (${suffix})`; suffix += 1; }
    seen.add(collisionKey(name));
    return { name, bytes: value.byteLength, storageKey: value.storageKey, sha256: value.sha256 };
  });
}

const INVISIBLE_OR_CONTROL = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const PATH_SEPARATORS = /[\\/\u2215\u2044\uff0f\uff3c]/gu;
const RESERVED_DOS = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
function safePart(value: string, fallback: string): string {
  // One archive entry component is generated by the server. Strip controls,
  // invisible/bidi formatting, slash forms and Windows device/path syntax.
  let result = value.normalize('NFKC')
    .replace(INVISIBLE_OR_CONTROL, '')
    .replace(/^(?:(?:[A-Za-z]:)|[\\/\u2215\u2044\uff0f\uff3c])+/u, '')
    .replace(PATH_SEPARATORS, '_')
    .replace(/[:*?"<>|]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^\.+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim();
  if (result === '.' || result === '..') result = '';
  if (RESERVED_DOS.test(result.split('.', 1)[0] ?? '')) result = `_${result}`;
  result = Array.from(result).slice(0, 100).join('').replace(/[. ]+$/g, '');
  return result || fallback;
}
function collisionKey(value: string): string {
  // ECMAScript lowercasing is not full Unicode case folding. These additions
  // cover common cross-platform collisions (straße/STRASSE and sigma).
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/ß/g, 'ss').replace(/ς/g, 'σ');
}

async function matchesExpected(handle: FileHandle, expectedBytes: number, expectedSha256: string): Promise<boolean> {
  const hash = createHash('sha256'); let count = 0;
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024, start: 0 })) {
      count += chunk.length;
      if (count > expectedBytes) return false;
      hash.update(chunk);
    }
    return count === expectedBytes && hash.digest('hex') === expectedSha256;
  } catch { return false; }
}
async function closePrepared(entries: readonly PreparedEntry[]): Promise<void> { await Promise.all(entries.map(async (entry) => entry.handle.close().catch(() => undefined))); }
async function write(response: ServerResponse, bytes: Uint8Array): Promise<void> {
  if (response.destroyed) throw new Error('FILE_EXPORT_ABORTED');
  if (!response.write(bytes)) await Promise.race([once(response, 'drain'), once(response, 'close').then(() => { throw new Error('FILE_EXPORT_ABORTED'); })]);
}

function u16(value: number): Uint8Array { const out = new Uint8Array(2); new DataView(out.buffer).setUint16(0, value, true); return out; }
function u32(value: number): Uint8Array { const out = new Uint8Array(4); new DataView(out.buffer).setUint32(0, value >>> 0, true); return out; }
function u64(value: number): Uint8Array { const out = new Uint8Array(8); new DataView(out.buffer).setBigUint64(0, BigInt(value), true); return out; }
function join(...items: Uint8Array[]): Uint8Array { const out = new Uint8Array(items.reduce((n, x) => n + x.length, 0)); let at = 0; for (const item of items) { out.set(item, at); at += item.length; } return out; }
function localHeader(name: Uint8Array): Uint8Array { return join(u32(0x04034b50), u16(20), u16(0x808), u16(0), u16(0), u16(0), u32(0), u32(0), u32(0), u16(name.length), u16(0), name); }
function dataDescriptor(crc: number, size: number): Uint8Array { return join(u32(0x08074b50), u32(crc), u32(size), u32(size)); }
function centralHeader(item: Central): Uint8Array {
  const offsetIsZip64 = item.offset >= UINT32_MAX;
  const extra = offsetIsZip64 ? join(u16(0x0001), u16(8), u64(item.offset)) : new Uint8Array();
  return join(u32(0x02014b50), u16(0x032d), u16(offsetIsZip64 ? 45 : 20), u16(0x808), u16(0), u16(0), u16(0), u32(item.crc), u32(item.bytes), u32(item.bytes), u16(item.name.length), u16(extra.length), u16(0), u16(0), u16(0), u32(0), u32(offsetIsZip64 ? UINT32_MAX : item.offset), item.name, extra);
}
function endRecords(count: number, size: number, offset: number, zip64Offset: number): Uint8Array {
  const needsZip64 = count >= UINT16_MAX || size >= UINT32_MAX || offset >= UINT32_MAX;
  if (!needsZip64) return endRecord(count, size, offset);
  const zip64End = join(u32(0x06064b50), u64(44), u16(0x032d), u16(45), u32(0), u32(0), u64(count), u64(count), u64(size), u64(offset));
  const locator = join(u32(0x07064b50), u32(0), u64(zip64Offset), u32(1));
  return join(zip64End, locator, endRecord(UINT16_MAX, UINT32_MAX, UINT32_MAX));
}
function endRecord(count: number, size: number, offset: number): Uint8Array { return join(u32(0x06054b50), u16(0), u16(0), u16(count), u16(count), u32(size), u32(offset), u16(0)); }

// Exported for binary-level tests; production uses it only through exportZip.
export const zipBinary = Object.freeze({ centralHeader, endRecords });
const CRC_TABLE = (() => { const table = new Uint32Array(256); for (let i = 0; i < 256; i += 1) { let value = i; for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; table[i] = value >>> 0; } return table; })();
function crc32(data: Uint8Array, state: number): number { let value = state; for (const byte of data) value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8); return value >>> 0; }
