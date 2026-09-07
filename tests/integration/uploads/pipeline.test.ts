import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqlite, type SqliteDatabase } from '../../../apps/server/src/db/connection.js';
import { migrate } from '../../../apps/server/src/db/migrator.js';
import { SqliteUploadPipelineRepository } from '../../../apps/server/src/db/upload-pipeline-repository.js';
import { SqliteFileSubmissionTaskRepository } from '../../../apps/server/src/db/file-submission-task-repository.js';
import { UploadPipeline, UploadReservationGate } from '../../../apps/server/src/uploads/pipeline.js';
import { UploadStorage } from '../../../apps/server/src/uploads/storage.js';
import type { UploadPipelineRepository } from '../../../apps/server/src/uploads/types.js';

let database: SqliteDatabase | undefined;
const directories: string[] = [];
let instant = new Date('2026-09-07T10:00:00.000Z');

async function setup(deadlineAtUtc = '2026-09-07T10:00:00.000Z') {
  database = openSqlite(':memory:'); migrate(database);
  database.prepare('INSERT INTO classes (id,name,created_at_utc,updated_at_utc) VALUES (?,?,?,?)').run('class-1', '1A', instant.toISOString(), instant.toISOString());
  database.prepare('INSERT INTO students (id,class_id,display_name,raw_student_number,normalized_student_number,is_temporary,approved_at_utc) VALUES (?,?,?,?,?,?,?)').run('student-1', 'class-1', 'Student', '1', '1', 0, instant.toISOString());
  database.prepare("INSERT INTO file_submission_tasks (id,class_id,title,description,state,max_bytes,deadline_at_utc,opened_at_utc,closed_at_utc,created_at_utc,updated_at_utc) VALUES (?,?,?,'', 'open',100000000,?, ?,NULL,?,?)").run('task-1', 'class-1', 'Task', deadlineAtUtc, instant.toISOString(), instant.toISOString(), instant.toISOString());
  const directory = await mkdtemp(join(tmpdir(), 'lan-upload-')); directories.push(directory);
  const repository = new SqliteUploadPipelineRepository(database, () => instant.toISOString());
  const storage = new UploadStorage(directory);
  return { repository, storage, pipeline: new UploadPipeline({ repository, storage, maxBytes: 8, now: () => instant }) };
}

afterEach(async () => { database?.close(); database = undefined; await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); instant = new Date('2026-09-07T10:00:00.000Z'); });

async function* chunks(...values: string[]): AsyncGenerator<Uint8Array> { for (const value of values) yield Buffer.from(value); }
async function* diskFull(): AsyncGenerator<Uint8Array> { yield new Uint8Array(0); throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); }

describe('upload byte pipeline', () => {
  it('streams, hashes, fsyncs and accepts a completion exactly at the server deadline', async () => {
    const { pipeline, storage } = await setup();
    const result = await pipeline.ingest({ taskId: 'task-1' as never, studentId: 'student-1' as never, bytes: chunks('ab', 'cd'), originalFilename: '..\\evil/ report.txt ' });
    expect(result).toMatchObject({ byteLength: 4, sha256: createHash('sha256').update('abcd').digest('hex'), receivedCompleteAtUtc: '2026-09-07T10:00:00.000Z' });
    expect(await storage.existsFinal(result.storageKey)).toBe(true);
    expect(database?.prepare('SELECT upload_sessions.state,upload_sessions.bytes_received,upload_sessions.sha256,upload_sessions.original_filename,file_submissions.storage_key FROM upload_sessions JOIN file_submissions ON file_submissions.id=upload_sessions.id').get()).toMatchObject({ state: 'metadata_committed', bytes_received: 4, original_filename: 'report.txt', storage_key: result.storageKey });
    await expect(pipeline.ingest({ taskId: 'task-1' as never, studentId: 'student-1' as never, bytes: chunks('again') })).rejects.toThrow('FILE_SUBMISSION_ALREADY_EXISTS');
  });

  it('rejects oversize, truncated, hash-mismatched and aborted streams without leaving a staged file', async () => {
    const { pipeline, storage } = await setup();
    await expect(pipeline.ingest({ taskId: 'task-1' as never, studentId: 'student-1' as never, bytes: chunks('12345', '6789') })).rejects.toMatchObject({ code: 'UPLOAD_TOO_LARGE' });
    await expect(pipeline.ingest({ taskId: 'task-1' as never, studentId: 'student-1' as never, bytes: chunks('123'), expectedBytes: 4 })).rejects.toMatchObject({ code: 'UPLOAD_TRUNCATED' });
    await expect(pipeline.ingest({ taskId: 'task-1' as never, studentId: 'student-1' as never, bytes: chunks('123'), expectedSha256: '0'.repeat(64) })).rejects.toMatchObject({ code: 'UPLOAD_HASH_MISMATCH' });
    await expect(pipeline.ingest({ taskId: 'task-1' as never, studentId: 'student-1' as never, bytes: chunks('123'), signal: { aborted: true } })).rejects.toMatchObject({ code: 'UPLOAD_ABORTED' });
    await expect(pipeline.ingest({ taskId: 'task-1' as never, studentId: 'student-1' as never, bytes: diskFull() })).rejects.toMatchObject({ code: 'UPLOAD_STORAGE_FULL' });
    expect(await readdir(join(storage.rootPath, 'staging')).catch(() => [])).toEqual([]);
    expect(database?.prepare("SELECT count(*) AS count FROM upload_sessions WHERE state='failed'").get()).toEqual({ count: 5 });
  });

  it('uses its own completion clock and rejects a stream that crosses the deadline', async () => {
    const { pipeline } = await setup(); instant = new Date('2026-09-07T10:00:00.001Z');
    await expect(pipeline.ingest({ taskId: 'task-1' as never, studentId: 'student-1' as never, bytes: chunks('late') })).rejects.toMatchObject({ code: 'UPLOAD_DEADLINE_EXPIRED' });
  });

  it('persists a rename intent and completes it after a database-commit failure or process restart', async () => {
    const { repository, storage, pipeline } = await setup();
    let failOnce = true;
    const failing: UploadPipelineRepository = {
      begin: (input) => repository.begin(input), recordVerified: (input) => repository.recordVerified(input), prepareFileCommit: (input) => repository.prepareFileCommit(input),
      commitAfterFileRename: (input) => { if (failOnce) { failOnce = false; throw new Error('simulated DB outage'); } repository.commitAfterFileRename(input); },
      markRecoveryPending: (id, code) => repository.markRecoveryPending(id, code), markFailed: (id, code) => repository.markFailed(id, code), markIntegrityFailure: (id, code) => repository.markIntegrityFailure(id, code), listForReconciliation: () => repository.listForReconciliation()
    };
    const interrupted = new UploadPipeline({ repository: failing, storage, maxBytes: 8, now: () => instant });
    await expect(interrupted.ingest({ taskId: 'task-1' as never, studentId: 'student-1' as never, bytes: chunks('abc') })).rejects.toMatchObject({ code: 'UPLOAD_METADATA_RECOVERY_PENDING' });
    expect(database?.prepare('SELECT state FROM upload_sessions').get()).toEqual({ state: 'recovery_pending' });
    expect((await pipeline.reconcile()).recovered).toBe(1);
    expect(database?.prepare('SELECT state FROM upload_sessions').get()).toEqual({ state: 'metadata_committed' });

    database?.prepare('UPDATE file_submissions SET deleted_at_utc=?').run(instant.toISOString());
    const session = randomUUID() as never; const stagingKey = storage.stagingKey(session); const finalKey = randomUUID();
    repository.begin({ uploadSessionId: session, taskId: 'task-1' as never, studentId: 'student-1' as never, stagingKey, originalFilename: 'x.txt', displayFilename: 'x.txt', declaredMimeType: null });
    const handle = await storage.openExclusiveStaging(stagingKey); await handle.write(Buffer.from('next')); await handle.sync(); await handle.close();
    repository.recordVerified({ uploadSessionId: session, bytesReceived: 4, sha256: createHash('sha256').update('next').digest('hex'), receivedCompleteAtUtc: instant.toISOString() });
    repository.prepareFileCommit({ uploadSessionId: session, finalStorageKey: finalKey });
    expect((await pipeline.reconcile()).recovered).toBe(1);
    expect(await storage.existsFinal(finalKey)).toBe(true);
  });

  it('enforces both global and per-student-task active reservations', () => {
    const perStudent = new UploadReservationGate(2); const release = perStudent.reserve('task', 'student');
    expect(() => perStudent.reserve('task', 'student')).toThrow('UPLOAD_ALREADY_ACTIVE_FOR_STUDENT_TASK'); release();
    const gate = new UploadReservationGate(1); const globalRelease = gate.reserve('task', 'student');
    expect(() => gate.reserve('other-task', 'other-student')).toThrow('UPLOAD_STREAM_LIMIT_REACHED'); globalRelease();

    // Fifty simultaneous admission attempts cannot overrun the global cap.
    const concurrent = new UploadReservationGate(10); const releases: Array<() => void> = [];
    for (let index = 0; index < 50; index += 1) {
      if (index < 10) releases.push(concurrent.reserve(`task-${index}`, `student-${index}`));
      else expect(() => concurrent.reserve(`task-${index}`, `student-${index}`)).toThrow('UPLOAD_STREAM_LIMIT_REACHED');
    }
    for (const release of releases) release();
  });

  it('uses reversible filesystem deletion for committed opaque objects', async () => {
    const { pipeline, storage } = await setup();
    const result = await pipeline.ingest({ taskId: 'task-1' as never, studentId: 'student-1' as never, bytes: chunks('abc') });
    const rollback = storage.stageDeletion([{ storageKey: result.storageKey, submissionId: result.uploadSessionId }]);
    expect(await storage.existsFinal(result.storageKey)).toBe(false);
    rollback.rollback();
    expect(await storage.existsFinal(result.storageKey)).toBe(true);
    const commit = storage.stageDeletion([{ storageKey: result.storageKey, submissionId: result.uploadSessionId }]);
    commit.commit();
    expect(await storage.existsFinal(result.storageKey)).toBe(false);
  });

  it('fails closed and permits resubmission when committed metadata has no final object', async () => {
    const { pipeline, storage } = await setup();
    const result = await pipeline.ingest({ taskId: 'task-1' as never, studentId: 'student-1' as never, bytes: chunks('abc') });
    await rm(storage.finalPath(result.storageKey));
    expect(await pipeline.reconcile()).toMatchObject({ metadataMissing: 1 });
    expect(database?.prepare('SELECT state,error_code FROM upload_sessions WHERE id=?').get(result.uploadSessionId)).toEqual({ state: 'failed', error_code: 'METADATA_FINAL_FILE_MISSING' });
    expect(database?.prepare('SELECT deleted_at_utc FROM file_submissions WHERE id=?').get(result.uploadSessionId)).toMatchObject({ deleted_at_utc: instant.toISOString() });
    expect(database?.prepare('SELECT integrity_code FROM upload_integrity_records WHERE upload_session_id=?').get(result.uploadSessionId)).toEqual({ integrity_code: 'METADATA_FINAL_FILE_MISSING' });
    await expect(pipeline.ingest({ taskId: 'task-1' as never, studentId: 'student-1' as never, bytes: chunks('next') })).resolves.toMatchObject({ byteLength: 4 });
  });

  it('reconciles deletion tombstones across both sides of the metadata transaction', async () => {
    const { pipeline, storage } = await setup();
    const fileRepository = new SqliteFileSubmissionTaskRepository(database!, () => instant.toISOString());
    const first = await pipeline.ingest({ taskId: 'task-1' as never, studentId: 'student-1' as never, bytes: chunks('abc') });
    // Crash after the atomic rename but before the DB soft delete: restore.
    storage.stageDeletion([{ storageKey: first.storageKey, submissionId: first.uploadSessionId }]);
    await expect(fileRepository.reconcileDeletionTombstones(storage)).resolves.toEqual({ restored: 1, completed: 0, failed: 0 });
    expect(await storage.existsFinal(first.storageKey)).toBe(true);

    const staged = storage.stageDeletion([{ storageKey: first.storageKey, submissionId: first.uploadSessionId }]);
    fileRepository.markSubmissionDeleted('task-1' as never, 'student-1' as never, instant.toISOString() as never);
    // Crash after DB commit but before physical removal: complete, without a false success.
    await expect(fileRepository.reconcileDeletionTombstones(storage)).resolves.toEqual({ restored: 0, completed: 1, failed: 0 });
    expect(await storage.existsFinal(first.storageKey)).toBe(false);
    expect(() => staged.commit()).toThrow(); // the restart already consumed its durable tombstone
  });

  it('keeps an explicit deletion failure record when restart cleanup cannot remove a tombstone', async () => {
    const { pipeline, storage } = await setup();
    const fileRepository = new SqliteFileSubmissionTaskRepository(database!, () => instant.toISOString());
    const result = await pipeline.ingest({ taskId: 'task-1' as never, studentId: 'student-1' as never, bytes: chunks('abc') });
    storage.stageDeletion([{ storageKey: result.storageKey, submissionId: result.uploadSessionId }]);
    fileRepository.markSubmissionDeleted('task-1' as never, 'student-1' as never, instant.toISOString() as never);
    const failingStorage = { listDeletionTombstones: () => storage.listDeletionTombstones(), restoreDeletionTombstone: (entry: { submissionId: string; storageKey: string }) => storage.restoreDeletionTombstone(entry), completeDeletionTombstone: async () => { throw new Error('simulated disk failure'); } };
    await expect(fileRepository.reconcileDeletionTombstones(failingStorage)).resolves.toEqual({ restored: 0, completed: 0, failed: 1 });
    expect(database?.prepare('SELECT deletion_error_code FROM file_deletion_markers WHERE submission_id=?').get(result.uploadSessionId)).toEqual({ deletion_error_code: 'DELETION_PHYSICAL_DELETE_FAILED' });
  });

  it('refuses startup when the private disk reservation is below the configured threshold', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lan-upload-capacity-')); directories.push(directory);
    const insufficient = new UploadStorage(directory, { minimumFreeBytes: 10, freeSpaceBytes: async () => 9 });
    await expect(insufficient.ensureReady()).rejects.toThrow('UPLOAD_STORAGE_INSUFFICIENT_SPACE');
    const ready = new UploadStorage(directory, { minimumFreeBytes: 10, freeSpaceBytes: async () => 10 });
    await expect(ready.ensureReady()).resolves.toBeUndefined();
  });
});
