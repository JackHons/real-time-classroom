import { createReadStream } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { once } from 'node:events';
import { TextEncoder } from 'node:util';
import type { FileExportSubmission } from '../file-tasks/types.js';
import type { UploadStorage } from './storage.js';

const MAX_EXPORT_FILES = 50;
const MAX_EXPORT_BYTES = 50 * 100_000_000;
const UTF8 = new TextEncoder();
const MAX_CONCURRENT_EXPORTS = 2;
let activeExports = 0;

type ZipEntry = Readonly<{ name: string; bytes: number; storageKey: string }>;
type Central = Readonly<{ name: Uint8Array; bytes: number; crc: number; offset: number }>;

/** Stored (uncompressed) ZIP stream.  It has bounded metadata and never holds
 * submission bytes in memory.  Data descriptors permit CRC calculation while
 * honouring response backpressure. */
export async function exportZip(response: ServerResponse, storage: UploadStorage, submissions: readonly FileExportSubmission[]): Promise<void> {
  return withExportSlot(async () => {
  if (submissions.length > MAX_EXPORT_FILES) throw new Error('FILE_EXPORT_LIMIT_EXCEEDED');
  const entries = makeEntries(submissions);
  const total = entries.reduce((sum, item) => sum + item.bytes, 0);
  if (!Number.isSafeInteger(total) || total > MAX_EXPORT_BYTES) throw new Error('FILE_EXPORT_LIMIT_EXCEEDED');
  await storage.ensureReady();
  // Verify every object before committing a response header.  This prevents an
  // archive containing an arbitrary subset after a missing/corrupt object.
  for (let index = 0; index < entries.length; index += 1) {
    const source = submissions[index]!;
    if (!await storage.verifyFinal(source.storageKey, source.byteLength, source.sha256)) throw new Error('FILE_EXPORT_INTEGRITY_FAILED');
  }
  response.writeHead(200, secureHeaders('submissions.zip'));
  let offset = 0;
  const central: Central[] = [];
  try {
    for (const entry of entries) {
      const name = UTF8.encode(entry.name);
      const localOffset = offset;
      const local = localHeader(name); offset += local.length;
      await write(response, local);
      let crc = 0xffffffff; let written = 0;
      const input = createReadStream(storage.finalPath(entry.storageKey), { highWaterMark: 64 * 1024 });
      try {
        for await (const chunk of input) { crc = crc32(chunk, crc); written += chunk.length; await write(response, chunk); offset += chunk.length; }
      } finally { input.destroy(); }
      if (written !== entry.bytes) throw new Error('FILE_EXPORT_INTEGRITY_FAILED');
      crc = (crc ^ 0xffffffff) >>> 0;
      const descriptor = dataDescriptor(crc, written); offset += descriptor.length;
      await write(response, descriptor);
      central.push({ name, bytes: written, crc, offset: localOffset });
    }
    const centralOffset = offset;
    for (const item of central) { const record = centralHeader(item); offset += record.length; await write(response, record); }
    await write(response, endRecord(central.length, offset - centralOffset, centralOffset));
    response.end();
  } catch (error) {
    // An aborted receiver must stop every file stream immediately.  Do not emit
    // filenames, paths, or database keys in an error body after ZIP started.
    if (!response.destroyed) response.destroy(error instanceof Error ? error : undefined);
    throw error;
  } });
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
    if (!Number.isSafeInteger(value.byteLength) || value.byteLength < 0 || value.byteLength > 100_000_000) throw new Error('FILE_EXPORT_INTEGRITY_FAILED');
    const base = `${safePart(value.studentNumber, 'student')}_${safePart(value.displayName, 'name')}_${safePart(value.originalFilename, 'file')}`.slice(0, 220);
    let name = base || `submission_${index + 1}`;
    let suffix = 2;
    while (seen.has(name.toLocaleLowerCase('en-US'))) { name = `${base.slice(0, 210)} (${suffix})`; suffix += 1; }
    seen.add(name.toLocaleLowerCase('en-US'));
    return { name, bytes: value.byteLength, storageKey: value.storageKey };
  });
}
function safePart(value: string, fallback: string): string {
  // Server generated, one flat component: no Zip Slip, drive/device forms,
  // controls, or visually invisible directory separators survive.
  const result = Array.from(value.normalize('NFKC'), (character) => {
    const code = character.charCodeAt(0);
    return character === '\\' || character === '/' || character === ':' || code < 32 || code === 127 ? '_' : character;
  }).join('').replace(/\.{2,}/g, '_').replace(/^\.+|\.+$/g, '').replace(/\s+/g, ' ').trim().slice(0, 100);
  return result || fallback;
}
async function write(response: ServerResponse, bytes: Uint8Array): Promise<void> {
  if (response.destroyed) throw new Error('FILE_EXPORT_ABORTED');
  if (!response.write(bytes)) {
    await Promise.race([once(response, 'drain'), once(response, 'close').then(() => { throw new Error('FILE_EXPORT_ABORTED'); })]);
  }
}
function u16(value: number): Uint8Array { const out = new Uint8Array(2); new DataView(out.buffer).setUint16(0, value, true); return out; }
function u32(value: number): Uint8Array { const out = new Uint8Array(4); new DataView(out.buffer).setUint32(0, value >>> 0, true); return out; }
function join(...items: Uint8Array[]): Uint8Array { const out = new Uint8Array(items.reduce((n, x) => n + x.length, 0)); let at = 0; for (const item of items) { out.set(item, at); at += item.length; } return out; }
function localHeader(name: Uint8Array): Uint8Array { return join(u32(0x04034b50), u16(20), u16(0x808), u16(0), u16(0), u16(0), u32(0), u32(0), u32(0), u16(name.length), u16(0), name); }
function dataDescriptor(crc: number, size: number): Uint8Array { return join(u32(0x08074b50), u32(crc), u32(size), u32(size)); }
function centralHeader(item: Central): Uint8Array { return join(u32(0x02014b50), u16(0x0314), u16(20), u16(0x808), u16(0), u16(0), u16(0), u32(item.crc), u32(item.bytes), u32(item.bytes), u16(item.name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(item.offset), item.name); }
function endRecord(count: number, size: number, offset: number): Uint8Array { return join(u32(0x06054b50), u16(0), u16(0), u16(count), u16(count), u32(size), u32(offset), u16(0)); }
const CRC_TABLE = (() => { const table = new Uint32Array(256); for (let i = 0; i < 256; i += 1) { let value = i; for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; table[i] = value >>> 0; } return table; })();
function crc32(data: Uint8Array, state: number): number { let value = state; for (const byte of data) value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8); return value >>> 0; }
