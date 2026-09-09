import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('uses its own completion clock to atomically close and reject a stream that crosses the deadline', async () => {
    const { pipeline } = await setup(); instant = new Date('2026-09-07T10:00:00.001Z');
    await expect(pipeline.ingest({ taskId: 'task-1' as never, studentId: 'student-1' as never, bytes: chunks('late') })).rejects.toMatchObject({ code: 'FILE_TASK_CLOSED' });
    expect(database?.prepare('SELECT state FROM file_submission_tasks WHERE id=?').get('task-1')).toEqual({ state: 'closed' });
  });

  it('closes an expired task once when concurrent uploads reach final metadata admission', async () => {
    const { repository, storage } = await setup();
    database?.prepare('INSERT INTO students (id,class_id,display_name,raw_student_number,normalized_student_number,is_temporary,approved_at_utc) VALUES (?,?,?,?,?,?,?)').run('student-2', 'class-1', 'Student 2', '2', '2', 0, instant.toISOString());
    instant = new Date('2026-09-07T10:00:00.001Z');
    const closed: unknown[] = [];
    const first = new UploadPipeline({ repository, storage, maxBytes: 8, now: () => instant, onTaskClosed: (task) => closed.push(task) });
    const second = new UploadPipeline({ repository, storage, maxBytes: 8, now: () => instant, onTaskClosed: (task) => closed.push(task) });
    await expect(Promise.all([first.ingest({ taskId: 'task-1' as never, studentId: 'student-1' as never, bytes: chunks('late-a') }), second.ingest({ taskId: 'task-1' as never, studentId: 'student-2' as never, bytes: chunks('late-b') })])).rejects.toMatchObject({ code: 'FILE_TASK_CLOSED' });
    expect(closed).toEqual([{ taskId: 'task-1', classId: 'class-1' }]);
    expect(database?.prepare('SELECT count(*) AS count FROM file_submissions').get()).toEqual({ count: 0 });
  });

  it('persists a rename intent and completes it after a database-commit failure or process restart', async () => {
    const { repository, storage, pipeline } = await setup();
    let failOnce = true;
    const failing: UploadPipelineRepository = {
      begin: (input) => repository.begin(input), recordVerified: (input) => repository.recordVerified(input), prepareFileCommit: (input) => repository.prepareFileCommit(input),
      commitAfterFileRename: (input) => { if (failOnce) { failOnce = false; throw new Error('simulated DB outage'); } repository.commitAfterFileRename(input); },
      markRecoveryPending: (id, code) => repository.markRecoveryPending(id, code), markFailed: (id, code) => repository.markFailed(id, code), markStagingCleanupFailed: (id, code) => repository.markStagingCleanupFailed(id, code), completeStagingCleanup: (id, code) => repository.completeStagingCleanup(id, code), markIntegrityFailure: (id, code) => repository.markIntegrityFailure(id, code), listForReconciliation: () => repository.listForReconciliation()
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

  it('does not recover a renamed upload after its deadline: it closes once and removes the final safely', async () => {
    const { repository, storage } = await setup();
    const session = randomUUID() as never; const stagingKey = storage.stagingKey(session); const finalKey = randomUUID();
    repository.begin({ uploadSessionId: session, taskId: 'task-1' as never, studentId: 'student-1' as never, stagingKey, originalFilename: 'late.txt', displayFilename: 'late.txt', declaredMimeType: null });
    const handle = await storage.openExclusiveStaging(stagingKey); await handle.write(Buffer.from('late')); await handle.sync(); await handle.close();
    repository.recordVerified({ uploadSessionId: session, bytesReceived: 4, sha256: createHash('sha256').update('late').digest('hex'), receivedCompleteAtUtc: instant.toISOString() });
    repository.prepareFileCommit({ uploadSessionId: session, finalStorageKey: finalKey });
    await storage.renameStagingToFinal(stagingKey, finalKey);
    instant = new Date('2026-09-07T10:00:00.001Z');
    const closed: unknown[] = [];
    const restarted = new UploadPipeline({ repository, storage, maxBytes: 8, now: () => instant, onTaskClosed: (task) => closed.push(task) });
    await expect(restarted.reconcile()).resolves.toMatchObject({ recovered: 0, cleaned: 1, cleanupFailed: 0 });
    restarted.flushTaskCloseNotifications();
    expect(await storage.existsFinal(finalKey)).toBe(false);
    expect(database?.prepare('SELECT state,staging_key,final_storage_key,error_code FROM upload_sessions WHERE id=?').get(session)).toEqual({ state: 'failed', staging_key: null, final_storage_key: null, error_code: 'FILE_TASK_CLOSED' });
    expect(closed).toEqual([{ taskId: 'task-1', classId: 'class-1' }]);
  });

  it('delivers an expired-close notification once after failed cleanup and a restart retry', async () => {
    const { repository, storage } = await setup();
    const session = randomUUID() as never; const stagingKey = storage.stagingKey(session); const finalKey = randomUUID();
    repository.begin({ uploadSessionId: session, taskId: 'task-1' as never, studentId: 'student-1' as never, stagingKey, originalFilename: 'late.txt', displayFilename: 'late.txt', declaredMimeType: null });
    const handle = await storage.openExclusiveStaging(stagingKey); await handle.write(Buffer.from('late')); await handle.sync(); await handle.close();
    repository.recordVerified({ uploadSessionId: session, bytesReceived: 4, sha256: createHash('sha256').update('late').digest('hex'), receivedCompleteAtUtc: instant.toISOString() });
    repository.prepareFileCommit({ uploadSessionId: session, finalStorageKey: finalKey });
    await storage.renameStagingToFinal(stagingKey, finalKey);
    instant = new Date('2026-09-07T10:00:00.001Z');
    const remove = vi.spyOn(storage, 'removeFinal').mockRejectedValue(new Error('simulated permission failure'));
    const closed: unknown[] = [];
    const restarted = new UploadPipeline({ repository, storage, maxBytes: 8, now: () => instant, onTaskClosed: (task) => closed.push(task) });
    await expect(restarted.reconcile()).resolves.toMatchObject({ recovered: 0, cleaned: 0, cleanupFailed: 1 });
    expect(await storage.existsFinal(finalKey)).toBe(true);
    expect(database?.prepare('SELECT state,final_storage_key FROM upload_sessions WHERE id=?').get(session)).toEqual({ state: 'recovery_pending', final_storage_key: finalKey });
    remove.mockRestore();
    const afterRestart = new UploadPipeline({ repository, storage, maxBytes: 8, now: () => instant, onTaskClosed: (task) => closed.push(task) });
    await expect(afterRestart.reconcile()).resolves.toMatchObject({ recovered: 0, cleaned: 1, cleanupFailed: 0 });
    expect(closed).toEqual([]);
    afterRestart.flushTaskCloseNotifications();
    afterRestart.flushTaskCloseNotifications();
    expect(closed).toEqual([{ taskId: 'task-1', classId: 'class-1' }]);
  });

  it('uses at-least-once delivery when a process crashes after emit but before outbox acknowledgement', async () => {
    const { repository, storage } = await setup();
    const session = randomUUID() as never; const stagingKey = storage.stagingKey(session); const finalKey = randomUUID();
    repository.begin({ uploadSessionId: session, taskId: 'task-1' as never, studentId: 'student-1' as never, stagingKey, originalFilename: 'late.txt', displayFilename: 'late.txt', declaredMimeType: null });
    const handle = await storage.openExclusiveStaging(stagingKey); await handle.write(Buffer.from('late')); await handle.sync(); await handle.close();
    repository.recordVerified({ uploadSessionId: session, bytesReceived: 4, sha256: createHash('sha256').update('late').digest('hex'), receivedCompleteAtUtc: instant.toISOString() });
    repository.prepareFileCommit({ uploadSessionId: session, finalStorageKey: finalKey });
    await storage.renameStagingToFinal(stagingKey, finalKey);
    instant = new Date('2026-09-07T10:00:00.001Z');
    const emitted: unknown[] = [];
    const pipeline = new UploadPipeline({ repository, storage, maxBytes: 8, now: () => instant, onTaskClosed: (task) => emitted.push(task) });
    await pipeline.reconcile();
    const acknowledge = vi.spyOn(repository, 'markTaskCloseNotificationDelivered').mockImplementationOnce(() => { throw new Error('simulated crash after emit'); });
    pipeline.flushTaskCloseNotifications();
    pipeline.flushTaskCloseNotifications();
    expect(emitted).toEqual([{ taskId: 'task-1', classId: 'class-1' }, { taskId: 'task-1', classId: 'class-1' }]);
    expect(repository.listPendingTaskCloseNotifications()).toEqual([]);
    acknowledge.mockRestore();
  });

  it('handles concurrent expired-intent reconciliation without duplicate durable delivery', async () => {
    const { repository, storage } = await setup();
    const session = randomUUID() as never; const stagingKey = storage.stagingKey(session); const finalKey = randomUUID();
    repository.begin({ uploadSessionId: session, taskId: 'task-1' as never, studentId: 'student-1' as never, stagingKey, originalFilename: 'late.txt', displayFilename: 'late.txt', declaredMimeType: null });
    const handle = await storage.openExclusiveStaging(stagingKey); await handle.write(Buffer.from('late')); await handle.sync(); await handle.close();
    repository.recordVerified({ uploadSessionId: session, bytesReceived: 4, sha256: createHash('sha256').update('late').digest('hex'), receivedCompleteAtUtc: instant.toISOString() });
    repository.prepareFileCommit({ uploadSessionId: session, finalStorageKey: finalKey });
    await storage.renameStagingToFinal(stagingKey, finalKey);
    instant = new Date('2026-09-07T10:00:00.001Z');
    const emitted: unknown[] = [];
    const first = new UploadPipeline({ repository, storage, maxBytes: 8, now: () => instant, onTaskClosed: (task) => emitted.push(task) });
    const second = new UploadPipeline({ repository, storage, maxBytes: 8, now: () => instant, onTaskClosed: (task) => emitted.push(task) });
    await expect(Promise.all([first.reconcile(), second.reconcile()])).resolves.toEqual([{ recovered: 0, cleaned: 1, metadataMissing: 0, cleanupFailed: 0 }, { recovered: 0, cleaned: 1, metadataMissing: 0, cleanupFailed: 0 }]);
    first.flushTaskCloseNotifications(); second.flushTaskCloseNotifications();
    expect(emitted).toEqual([{ taskId: 'task-1', classId: 'class-1' }]);
  });

  it('keeps best-effort close notification compatibility for adapters without the durable outbox contract', async () => {
    const { repository, storage } = await setup();
    instant = new Date('2026-09-07T10:00:00.001Z');
    const legacy: UploadPipelineRepository = {
      begin: (input) => repository.begin(input), recordVerified: (input) => repository.recordVerified(input), prepareFileCommit: (input) => repository.prepareFileCommit(input), commitAfterFileRename: (input) => repository.commitAfterFileRename(input),
      completeRejectedFileCommit: (input) => repository.completeRejectedFileCommit(input), markRecoveryPending: (id, code) => repository.markRecoveryPending(id, code), markFailed: (id, code) => repository.markFailed(id, code), markStagingCleanupFailed: (id, code) => repository.markStagingCleanupFailed(id, code), completeStagingCleanup: (id, code) => repository.completeStagingCleanup(id, code), markIntegrityFailure: (id, code) => repository.markIntegrityFailure(id, code), listForReconciliation: () => repository.listForReconciliation()
    };
    const emitted: unknown[] = [];
    const pipeline = new UploadPipeline({ repository: legacy, storage, maxBytes: 8, now: () => instant, onTaskClosed: (task) => emitted.push(task) });
    await expect(pipeline.ingest({ taskId: 'task-1' as never, studentId: 'student-1' as never, bytes: chunks('late') })).rejects.toMatchObject({ code: 'FILE_TASK_CLOSED' });
    expect(emitted).toEqual([{ taskId: 'task-1', classId: 'class-1' }]);
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

  it('retains failed staging cleanup for a later restart, then clears its durable key and writes a payload-free audit', async () => {
    const { repository, storage, pipeline } = await setup();
    const session = randomUUID() as never;
    const stagingKey = storage.stagingKey(session);
    repository.begin({ uploadSessionId: session, taskId: 'task-1' as never, studentId: 'student-1' as never, stagingKey, originalFilename: 'partial.txt', displayFilename: 'partial.txt', declaredMimeType: null });
    const handle = await storage.openExclusiveStaging(stagingKey); await handle.write(Buffer.from('partial')); await handle.close();
    const physicalRemove = storage.removeStaging.bind(storage);
    const remove = vi.spyOn(storage, 'removeStaging').mockRejectedValue(new Error('simulated permission failure'));

    await expect(pipeline.reconcile()).resolves.toMatchObject({ cleaned: 0, cleanupFailed: 1 });
    expect(database?.prepare('SELECT state,staging_key,error_code FROM upload_sessions WHERE id=?').get(session)).toEqual({ state: 'failed', staging_key: stagingKey, error_code: 'RESTART_STAGING_CLEANUP_FAILED' });
    expect(database?.prepare('SELECT * FROM upload_staging_cleanup_records WHERE upload_session_id=?').get(session)).toBeUndefined();
    expect(new SqliteFileSubmissionTaskRepository(database!).deleteEmptyTask('task-1' as never)).toBe(false);

    remove.mockImplementation(physicalRemove);
    const restarted = new UploadPipeline({ repository, storage, maxBytes: 8, now: () => instant });
    await expect(restarted.reconcile()).resolves.toMatchObject({ cleaned: 1, cleanupFailed: 0 });
    expect(await storage.existsStaging(stagingKey)).toBe(false);
    expect(database?.prepare('SELECT state,staging_key,error_code FROM upload_sessions WHERE id=?').get(session)).toEqual({ state: 'failed', staging_key: null, error_code: 'RESTART_STAGING_CLEANED' });
    expect(database?.prepare('SELECT cleanup_code FROM upload_staging_cleanup_records WHERE upload_session_id=?').get(session)).toEqual({ cleanup_code: 'RESTART_STAGING_CLEANED' });
    expect(new SqliteFileSubmissionTaskRepository(database!).deleteEmptyTask('task-1' as never)).toBe(true);
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
