import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqlite, type SqliteDatabase } from '../../../apps/server/src/db/connection.js';
import { migrate } from '../../../apps/server/src/db/migrator.js';
import { SqliteDomainRepository, SqliteFileMetadataRepository } from '../../../apps/server/src/db/sqlite-repositories.js';
import { SqliteFileSubmissionTaskRepository } from '../../../apps/server/src/db/file-submission-task-repository.js';
import type { ClassId, StudentId } from '../../../apps/server/src/domain/types.js';
let database: SqliteDatabase | undefined;

function setup(): SqliteDomainRepository {
  database = openSqlite(':memory:');
  migrate(database);
  let tick = 0;
  const repository = new SqliteDomainRepository(database, () => `2026-09-07T00:00:0${tick++}.000Z`);
  repository.createClass({ id: 'class-1' as ClassId, name: '1A', createdAtUtc: '2026-09-07T00:00:00.000Z' as never, updatedAtUtc: '2026-09-07T00:00:00.000Z' as never });
  repository.createStudent({ id: 'student-1' as StudentId, classId: 'class-1' as ClassId, displayName: 'Ada', rawStudentNumber: 'a1', normalizedStudentNumber: 'A1', isTemporary: false, approvedAtUtc: '2026-09-07T00:00:00.000Z' as never });
  repository.createStudent({ id: 'student-2' as StudentId, classId: 'class-1' as ClassId, displayName: 'Ben', rawStudentNumber: 'b2', normalizedStudentNumber: 'B2', isTemporary: true, approvedAtUtc: '2026-09-07T00:00:00.000Z' as never });
  return repository;
}

afterEach(() => database?.close());

describe('SQLite migration and repository transactions', () => {
  it('upgrades retained upload data from every predecessor schema to the integrity-record schema', () => {
    const predecessorMigrations = [
      '0001_initial',
      '0002_answer_at_close_roster_snapshot',
      '0003_upload_session_recovery_metadata',
      '0004_upload_storage_integrity'
    ] as const;
    const sqlFor = (id: string) => readFileSync(new URL(`../../../apps/server/src/db/migrations/${id}.sql`, import.meta.url), 'utf8');

    for (let predecessor = 0; predecessor < predecessorMigrations.length; predecessor += 1) {
      const legacy = openSqlite(':memory:');
      try {
        legacy.exec('CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at_utc TEXT NOT NULL)');
        for (let index = 0; index <= predecessor; index += 1) {
          const id = predecessorMigrations[index]!;
          legacy.exec(sqlFor(id));
          legacy.prepare('INSERT INTO schema_migrations (id,applied_at_utc) VALUES (?,?)').run(id, '2026-09-08T00:00:00.000Z');
        }
        legacy.prepare('INSERT INTO classes (id,name,created_at_utc,updated_at_utc) VALUES (?,?,?,?)').run(`class-${predecessor}`, `Class ${predecessor}`, 'now', 'now');
        legacy.prepare('INSERT INTO students (id,class_id,display_name,raw_student_number,normalized_student_number,is_temporary,approved_at_utc) VALUES (?,?,?,?,?,?,?)').run(`student-${predecessor}`, `class-${predecessor}`, 'Student', '1', `S${predecessor}`, 0, 'now');
        legacy.prepare("INSERT INTO file_submission_tasks (id,class_id,title,description,state,max_bytes,deadline_at_utc,opened_at_utc,closed_at_utc,created_at_utc,updated_at_utc) VALUES (?,?,?,'','open',100000000,'2099-01-01T00:00:00.000Z','now',NULL,'now','now')").run(`task-${predecessor}`, `class-${predecessor}`, 'Task');
        legacy.prepare('INSERT INTO upload_sessions (id,task_id,student_id,idempotency_key,state,staging_key,final_storage_key,bytes_received,sha256,received_complete_at_utc,error_code,created_at_utc,updated_at_utc) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(`upload-${predecessor}`, `task-${predecessor}`, `student-${predecessor}`, 'key', 'failed', null, null, 0, null, null, 'legacy', 'now', 'now');

        migrate(legacy);

        expect(legacy.prepare('SELECT state,error_code FROM upload_sessions WHERE id=?').get(`upload-${predecessor}`)).toEqual({ state: 'failed', error_code: 'legacy' });
        expect(legacy.prepare("SELECT id FROM schema_migrations WHERE id='0004_upload_storage_integrity'").get()).toBeDefined();
        expect(legacy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='upload_integrity_records'").get()).toBeDefined();
        expect(legacy.prepare("SELECT id FROM schema_migrations WHERE id='0005_upload_staging_cleanup_audit'").get()).toBeDefined();
        expect(legacy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='upload_staging_cleanup_records'").get()).toBeDefined();
      } finally { legacy.close(); }
    }
  });

  it('enables WAL for a file-backed database', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lan-classroom-sqlite-'));
    const persistent = openSqlite(join(directory, 'test.sqlite'));
    try {
      expect(persistent.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(persistent.pragma('foreign_keys', { simple: true })).toBe(1);
    } finally {
      persistent.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('enables migration tables and enforces roster/session/file constraints', () => {
    setup();
    expect(database?.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(database?.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(database?.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='upload_sessions'").get()).toBeDefined();
    expect(() => database?.prepare('INSERT INTO students (id,class_id,display_name,raw_student_number,normalized_student_number,is_temporary,approved_at_utc) VALUES (?,?,?,?,?,?,?)').run('duplicate', 'class-1', 'Other', 'A1', 'A1', 0, '2026-09-07T00:00:00.000Z')).toThrow();
    database?.prepare('INSERT INTO student_sessions VALUES (?,?,?,?,?,?,?,?,?)').run('s1', 'student-1', 'class-1', 'token-1', 'now', 'now', 'later', 'later', null);
    expect(() => database?.prepare('INSERT INTO student_sessions VALUES (?,?,?,?,?,?,?,?,?)').run('s2', 'student-1', 'class-1', 'token-2', 'now', 'now', 'later', 'later', null)).toThrow();
    expect(() => database?.prepare('INSERT INTO student_sessions VALUES (?,?,?,?,?,?,?,?,?)').run('cross-class', 'student-1', 'wrong-class', 'token-3', 'now', 'now', 'later', 'later', null)).toThrow();
    expect(() => database?.prepare('INSERT INTO app_settings VALUES (?,?,?,?)').run('invalid_setting', 'x', 'now', 'now')).toThrow();
  });

  it('revokes an expired session in the same transaction before allowing a replacement', () => {
    const repository = setup();
    repository.createStudentSession({ id: 'expired' as never, studentId: 'student-1' as StudentId, classId: 'class-1' as ClassId, tokenHash: 'old', createdAtUtc: '2026-09-06T00:00:00.000Z' as never, lastSeenAtUtc: '2026-09-06T00:00:00.000Z' as never, absoluteExpiresAtUtc: '2026-09-06T12:00:00.000Z' as never, idleExpiresAtUtc: '2026-09-06T02:00:00.000Z' as never, revokedAtUtc: null });
    repository.createStudentSession({ id: 'replacement' as never, studentId: 'student-1' as StudentId, classId: 'class-1' as ClassId, tokenHash: 'new', createdAtUtc: '2026-09-07T00:00:00.000Z' as never, lastSeenAtUtc: '2026-09-07T00:00:00.000Z' as never, absoluteExpiresAtUtc: '2026-09-07T12:00:00.000Z' as never, idleExpiresAtUtc: '2026-09-07T02:00:00.000Z' as never, revokedAtUtc: null });
    expect(database?.prepare('SELECT revoked_at_utc FROM student_sessions WHERE id=?').get('expired')).toMatchObject({ revoked_at_utc: expect.any(String) });
  });

  it('persists template options and only permits an exact template-backed draft snapshot', () => {
    const repository = setup();
    const template = repository.createQuestionTemplate({ id: 'template-1' as never, kind: 'single_choice', prompt: 'Pick a letter', options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }], referenceAnswer: 'a' });
    expect(repository.listQuestionTemplates()).toEqual([template]);

    const draft = repository.createQuestion({ id: 'template-draft' as never, classId: 'class-1' as ClassId, templateId: template.id, kind: template.kind, prompt: template.prompt, options: template.options.map(({ key, label }) => ({ key, label })), referenceAnswer: template.referenceAnswer });
    expect(draft).toMatchObject({ templateId: template.id, options: template.options });
    expect(() => repository.createQuestion({ id: 'mismatched-template-draft' as never, classId: 'class-1' as ClassId, templateId: template.id, kind: template.kind, prompt: template.prompt, options: [{ key: 'a', label: 'Changed' }, { key: 'b', label: 'B' }], referenceAnswer: template.referenceAnswer })).toThrow('QUESTION_TEMPLATE_SNAPSHOT_MISMATCH');
    expect(database?.prepare('SELECT id FROM questions WHERE id=?').get('mismatched-template-draft')).toBeUndefined();
    expect(() => repository.createQuestion({ id: 'missing-template-draft' as never, classId: 'class-1' as ClassId, templateId: 'missing-template' as never, kind: 'short_text', prompt: 'Missing', options: [] })).toThrow('QUESTION_TEMPLATE_NOT_FOUND');
    expect(database?.prepare('SELECT id FROM questions WHERE id=?').get('missing-template-draft')).toBeUndefined();
  });

  it('closes atomically, snapshots no-answer rows, and rejects reopen', () => {
    const repository = setup();
    repository.createQuestion({ id: 'q1' as never, classId: 'class-1' as ClassId, kind: 'single_choice', prompt: 'Pick', options: [{ key: 'a', label: 'A' }] });
    repository.transitionQuestion('q1' as never, 'open');
    repository.submitAnswer('student-1' as StudentId, { questionId: 'q1' as never, revision: 1, idempotencyKey: 'key-1', requestFingerprint: 'request-1', payload: { kind: 'single_choice', selectedOptions: ['a'] } });
    const snapshot = repository.closeQuestion('q1' as never);
    expect(snapshot.counts).toEqual({ a: 1 });
    expect(repository.answerAtClose('q1' as never, 'student-2' as never)?.noAnswer).toBe(true);
    expect(() => repository.transitionQuestion('q1' as never, 'open')).toThrow('Invalid lifecycle transition');
    expect(() => repository.transitionQuestion('q1' as never, 'draft')).toThrow('Invalid lifecycle transition');
  });

  it('rolls back a multi-row question insert when an option constraint fails', () => {
    const repository = setup();
    expect(() => repository.createQuestion({ id: 'rolled-back' as never, classId: 'class-1' as ClassId, kind: 'single_choice', prompt: 'Pick', options: [{ key: 'same', label: 'A' }, { key: 'same', label: 'B' }] })).toThrow();
    expect(database?.prepare('SELECT id FROM questions WHERE id=?').get('rolled-back')).toBeUndefined();
  });

  it('keeps late answers separate and replays an idempotent result immutably', () => {
    const repository = setup();
    repository.createQuestion({ id: 'q2' as never, classId: 'class-1' as ClassId, kind: 'short_text', prompt: 'Why?', options: [] });
    repository.transitionQuestion('q2' as never, 'open');
    const input = { questionId: 'q2' as never, revision: 1, idempotencyKey: 'same-key', requestFingerprint: 'same-request', payload: { kind: 'short_text' as const, text: 'on time' } };
    const first = repository.submitAnswer('student-1' as StudentId, input);
    expect(repository.submitAnswer('student-1' as StudentId, input)).toEqual(first);
    repository.closeQuestion('q2' as never);
    repository.submitAnswer('student-1' as StudentId, { ...input, revision: 2, idempotencyKey: 'late-key', requestFingerprint: 'late-request', payload: { kind: 'short_text', text: 'late' } });
    expect(repository.answerAtClose('q2' as never, 'student-1' as never)?.payload).toEqual({ kind: 'short_text', text: 'on time' });
    expect(() => repository.submitAnswer('student-1' as StudentId, { ...input, requestFingerprint: 'different' })).toThrow('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST');
  });

  it('physically deletes answer payloads while preserving the anonymous snapshot and audit marker', () => {
    const repository = setup();
    repository.createQuestion({ id: 'q3' as never, classId: 'class-1' as ClassId, kind: 'single_choice', prompt: 'Pick', options: [{ key: 'a', label: 'A' }] });
    repository.transitionQuestion('q3' as never, 'open');
    repository.submitAnswer('student-1' as StudentId, { questionId: 'q3' as never, revision: 1, idempotencyKey: 'delete-key', requestFingerprint: 'delete-request', payload: { kind: 'single_choice', selectedOptions: ['a'] } });
    const snapshot = repository.closeQuestion('q3' as never);
    repository.deleteAnswer('q3' as never, 'student-1' as never, { confirmed: true, impactAcknowledged: true });
    expect(repository.answerAtClose('q3' as never, 'student-1' as never)).toBeUndefined();
    expect(snapshot.counts).toEqual({ a: 1 });
    expect(database?.prepare('SELECT deleted_at_utc FROM answer_deletion_markers WHERE question_id=? AND student_id=?').get('q3', 'student-1')).toBeDefined();
    expect(database?.prepare('SELECT response_json FROM answer_submission_idempotency WHERE question_id=? AND student_id=?').get('q3', 'student-1')).toBeUndefined();
    const resubmitted = repository.submitAnswer('student-1' as StudentId, { questionId: 'q3' as never, revision: 2, idempotencyKey: 'delete-key', requestFingerprint: 'new-request', payload: { kind: 'single_choice', selectedOptions: [] } });
    expect(resubmitted.payload).toEqual({ kind: 'single_choice', selectedOptions: [] });
  });

  it('enforces one metadata-committed upload and defensive final-key metadata commits', () => {
    const repository = setup();
    repository.createFileTask({ id: 'task-1' as never, classId: 'class-1' as ClassId, title: 'Exit file', description: '', deadlineAtUtc: '2026-09-07T01:00:00.000Z' });
    const insertUpload = database?.prepare('INSERT INTO upload_sessions (id,task_id,student_id,idempotency_key,state,staging_key,final_storage_key,bytes_received,sha256,received_complete_at_utc,error_code,created_at_utc,updated_at_utc) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
    insertUpload?.run('upload-1', 'task-1', 'student-1', 'upload-key', 'file_committed', 'staging-1', 'final-1', 1, 'a'.repeat(64), '2026-09-07T00:00:00.000Z', null, '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z');
    const metadata = new SqliteFileMetadataRepository(database!, () => '2026-09-07T00:00:01.000Z');
    expect(() => metadata.commitAfterFileRename({ uploadSessionId: 'upload-1' as never, finalStorageKey: 'wrong-key' })).toThrow('FILE_METADATA_COMMIT_PRECONDITION_FAILED');
    metadata.commitAfterFileRename({ uploadSessionId: 'upload-1' as never, finalStorageKey: 'final-1' });
    expect(database?.prepare('SELECT state FROM upload_sessions WHERE id=?').get('upload-1')).toMatchObject({ state: 'metadata_committed' });
    expect(() => insertUpload?.run('upload-2', 'task-1', 'student-1', 'upload-key-2', 'metadata_committed', null, 'final-2', 1, 'b'.repeat(64), '2026-09-07T00:00:00.000Z', null, '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z')).toThrow();
  });

  it('refuses task deletion while any durable upload intent can still own a file', () => {
    setup();
    database?.prepare("INSERT INTO file_submission_tasks (id,class_id,title,description,state,max_bytes,deadline_at_utc,opened_at_utc,closed_at_utc,created_at_utc,updated_at_utc) VALUES ('task-pending','class-1','Pending','', 'draft',100000000,'2099-01-01T00:00:00.000Z',NULL,NULL,'now','now')").run();
    const upload = database?.prepare("INSERT INTO upload_sessions (id,task_id,student_id,idempotency_key,state,staging_key,final_storage_key,bytes_received,sha256,received_complete_at_utc,error_code,created_at_utc,updated_at_utc,original_filename,display_filename,declared_mime_type) VALUES (?,?,?,?, 'staging',?,NULL,0,NULL,NULL,NULL,'now','now',NULL,NULL,NULL)");
    const fileTasks = new SqliteFileSubmissionTaskRepository(database!);
    upload?.run('pending-upload', 'task-pending', 'student-1', 'key', 'staging/pending.part');
    for (const state of ['queued', 'staging', 'validating', 'file_committed', 'metadata_committed', 'recovery_pending'] as const) {
      database?.prepare('UPDATE upload_sessions SET state=?, final_storage_key=? WHERE id=?').run(state, state === 'queued' || state === 'staging' || state === 'validating' ? null : 'a'.repeat(36), 'pending-upload');
      expect(fileTasks.deleteEmptyTask('task-pending' as never)).toBe(false);
      expect(database?.prepare('SELECT id FROM file_submission_tasks WHERE id=?').get('task-pending')).toBeDefined();
    }
    database?.prepare("UPDATE upload_sessions SET state='failed' WHERE id='pending-upload'").run();
    expect(fileTasks.deleteEmptyTask('task-pending' as never)).toBe(false);
    database?.prepare("UPDATE upload_sessions SET staging_key=NULL,final_storage_key=NULL WHERE id='pending-upload'").run();
    expect(fileTasks.deleteEmptyTask('task-pending' as never)).toBe(true);
  });
});
