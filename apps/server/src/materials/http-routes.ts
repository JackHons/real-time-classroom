import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SqliteDatabase } from '../db/connection.js';
import type { ClassId } from '../domain/types.js';
import { UploadStorage } from '../uploads/storage.js';

const MAX_MATERIAL_BYTES = 25 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['application/pdf', 'text/plain', 'image/png', 'image/jpeg', 'application/zip', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);
type TeacherContext = (request: IncomingMessage) => unknown;
type StudentContext = (request: IncomingMessage) => Readonly<{ classId: ClassId }>;
type MaterialRow = Readonly<{ id: string; classId: string; displayFilename: string; declaredMimeType: string; byteLength: number; sha256: string; storageKey: string; createdAtUtc: string }>;

/** Teacher materials use generated objects in the same hardened private store
 * as submissions, but retain entirely separate metadata and routes. */
export function createMaterialRoutes(dependencies: Readonly<{ database: SqliteDatabase; storage: UploadStorage; teacherContext: TeacherContext; studentContext: StudentContext }>): (request: IncomingMessage, response: ServerResponse) => Promise<boolean> {
  return async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const download = /^\/api\/classes\/([^/]+)\/materials\/([^/]+)\/download$/.exec(url.pathname);
    if (request.method === 'GET' && download !== null) {
      const classId = decodeURIComponent(download[1]!) as ClassId; const student = dependencies.studentContext(request);
      if (student.classId !== classId) throw new Error('MATERIAL_NOT_FOUND');
      const material = find(dependencies.database, classId, decodeURIComponent(download[2]!));
      if (material === undefined) throw new Error('MATERIAL_NOT_FOUND');
      await downloadMaterial(response, dependencies.storage, material); return true;
    }
    const item = /^\/api\/classes\/([^/]+)\/materials\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'DELETE' && item !== null) {
      dependencies.teacherContext(request); const classId = decodeURIComponent(item[1]!) as ClassId;
      const material = find(dependencies.database, classId, decodeURIComponent(item[2]!)); if (material === undefined) throw new Error('MATERIAL_NOT_FOUND');
      const staged = dependencies.storage.stageDeletion([{ submissionId: material.id as never, storageKey: material.storageKey }]);
      try { dependencies.database.prepare('DELETE FROM class_materials WHERE id=? AND class_id=?').run(material.id, classId); staged.commit(); }
      catch (error) { staged.rollback(); throw error; }
      response.writeHead(204, { 'cache-control': 'no-store' }); response.end(); return true;
    }
    const base = /^\/api\/classes\/([^/]+)\/materials$/.exec(url.pathname);
    if (base === null) return false;
    const classId = decodeURIComponent(base[1]!) as ClassId;
    if (request.method === 'GET') { dependencies.teacherContext(request); send(response, 200, list(dependencies.database, classId)); return true; }
    if (request.method !== 'POST') return false;
    dependencies.teacherContext(request);
    if (!classExists(dependencies.database, classId)) throw new Error('CLASS_NOT_FOUND');
    const filename = safeFilename(header(request, 'x-upload-filename') ?? 'material'); const mime = mediaType(request.headers['content-type']);
    if (mime === undefined || !ALLOWED_TYPES.has(mime)) throw new Error('MATERIAL_TYPE_NOT_ALLOWED');
    const declared = contentLength(request); if (declared !== undefined && declared > MAX_MATERIAL_BYTES) throw new Error('MATERIAL_TOO_LARGE');
    const id = randomUUID(); const staging = dependencies.storage.stagingKey(id); const storageKey = randomUUID(); const createdAtUtc = new Date().toISOString();
    let handle: Awaited<ReturnType<UploadStorage['openExclusiveStaging']>> | undefined;
    try {
      handle = await dependencies.storage.openExclusiveStaging(staging);
      const result = await writeAndHash(handle, request); await handle.sync(); await handle.close(); handle = undefined;
      await dependencies.storage.renameStagingToFinal(staging, storageKey);
      try { dependencies.database.prepare('INSERT INTO class_materials (id,class_id,display_filename,declared_mime_type,byte_length,sha256,storage_key,created_at_utc) VALUES (?,?,?,?,?,?,?,?)').run(id, classId, filename, mime, result.byteLength, result.sha256, storageKey, createdAtUtc); }
      catch (error) { await dependencies.storage.removeFinal(storageKey).catch(() => undefined); throw error; }
      send(response, 201, publicMaterial({ id, classId, displayFilename: filename, declaredMimeType: mime, byteLength: result.byteLength, sha256: result.sha256, storageKey, createdAtUtc })); return true;
    } catch (error) { await handle?.close().catch(() => undefined); await dependencies.storage.removeStaging(staging).catch(() => undefined); throw error; }
  };
}
export function listStudentMaterials(database: SqliteDatabase, classId: ClassId): readonly ReturnType<typeof publicMaterial>[] { return list(database, classId); }
function list(database: SqliteDatabase, classId: ClassId): readonly ReturnType<typeof publicMaterial>[] { return (database.prepare('SELECT id,class_id AS classId,display_filename AS displayFilename,declared_mime_type AS declaredMimeType,byte_length AS byteLength,sha256,storage_key AS storageKey,created_at_utc AS createdAtUtc FROM class_materials WHERE class_id=? ORDER BY created_at_utc DESC,id DESC').all(classId) as readonly MaterialRow[]).map(publicMaterial); }
function find(database: SqliteDatabase, classId: ClassId, id: string): MaterialRow | undefined { return database.prepare('SELECT id,class_id AS classId,display_filename AS displayFilename,declared_mime_type AS declaredMimeType,byte_length AS byteLength,sha256,storage_key AS storageKey,created_at_utc AS createdAtUtc FROM class_materials WHERE id=? AND class_id=?').get(id, classId) as MaterialRow | undefined; }
function publicMaterial(row: MaterialRow): Readonly<{ id: string; classId: string; displayFilename: string; declaredMimeType: string; byteLength: number; createdAtUtc: string }> { return { id: row.id, classId: row.classId, displayFilename: row.displayFilename, declaredMimeType: row.declaredMimeType, byteLength: row.byteLength, createdAtUtc: row.createdAtUtc }; }
function classExists(database: SqliteDatabase, classId: ClassId): boolean { return database.prepare('SELECT 1 FROM classes WHERE id=?').get(classId) !== undefined; }
function header(request: IncomingMessage, name: string): string | undefined { const value = request.headers[name]; return typeof value === 'string' ? value : undefined; }
function mediaType(value: string | string[] | undefined): string | undefined { if (typeof value !== 'string') return undefined; const type = value.split(';', 1)[0]!.trim().toLowerCase(); return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type) ? type : undefined; }
function contentLength(request: IncomingMessage): number | undefined { const value = header(request, 'content-length'); if (value === undefined) return undefined; if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error('MATERIAL_INVALID_CONTENT_LENGTH'); const length = Number(value); if (!Number.isSafeInteger(length)) throw new Error('MATERIAL_INVALID_CONTENT_LENGTH'); return length; }
const filenameControlRange = `${String.fromCharCode(0)}-${String.fromCharCode(31)}`;
const unsafeFilenameCharacters = new RegExp(`[\\\\/:*?"<>|${filenameControlRange}]`, 'g');
function safeFilename(value: string): string { const cleaned = value.normalize('NFKC').replace(unsafeFilenameCharacters, '_').replace(/\s+/g, ' ').trim().slice(0, 180); return cleaned.length === 0 || cleaned === '.' || cleaned === '..' ? 'material' : cleaned; }
async function writeAndHash(handle: Awaited<ReturnType<UploadStorage['openExclusiveStaging']>>, source: AsyncIterable<Uint8Array>): Promise<Readonly<{ byteLength: number; sha256: string }>> { const hash = createHash('sha256'); let byteLength = 0; for await (const chunk of source) { byteLength += chunk.length; if (byteLength > MAX_MATERIAL_BYTES) throw new Error('MATERIAL_TOO_LARGE'); hash.update(chunk); await handle.write(chunk); } return { byteLength, sha256: hash.digest('hex') }; }
async function downloadMaterial(response: ServerResponse, storage: UploadStorage, material: MaterialRow): Promise<void> { if (!await storage.verifyFinal(material.storageKey, material.byteLength, material.sha256)) throw new Error('MATERIAL_NOT_FOUND'); const handle = await storage.openVerifiedFinal(material.storageKey); const hash = createHash('sha256'); let bytes = 0; try { response.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${material.displayFilename.replace(/["\\]/g, '_')}"`, 'content-length': String(material.byteLength), 'x-content-type-options': 'nosniff' }); for await (const chunk of handle.createReadStream({ autoClose: false })) { bytes += chunk.length; hash.update(chunk); if (bytes > material.byteLength) throw new Error('MATERIAL_NOT_FOUND'); if (!response.write(chunk)) await once(response, 'drain'); } if (bytes !== material.byteLength || hash.digest('hex') !== material.sha256) throw new Error('MATERIAL_NOT_FOUND'); response.end(); } finally { await handle.close().catch(() => undefined); } }
function send(response: ServerResponse, status: number, body: unknown): void { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)); }
