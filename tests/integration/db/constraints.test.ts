import { afterEach, describe, expect, it } from 'vitest';
import { openSqlite, type SqliteDatabase } from '../../../apps/server/src/db/connection.js';
import { migrate } from '../../../apps/server/src/db/migrator.js';
import { SqliteDomainRepository } from '../../../apps/server/src/db/sqlite-repositories.js';
import type { AuthorizedStudentContext, AuthorizedTeacherContext, ClassId, StudentId } from '../../../apps/server/src/domain/types.js';

const teacher = { teacherSessionId: 'teacher-session' as AuthorizedTeacherContext['teacherSessionId'], csrfValidated: true } as const;
const studentContext = (studentId: string): AuthorizedStudentContext => ({ studentSessionId: `${studentId}-session` as AuthorizedStudentContext['studentSessionId'], studentId: studentId as StudentId, classId: 'class-1' as ClassId, csrfValidated: true });
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
  });

  it('revokes an expired session in the same transaction before allowing a replacement', () => {
    const repository = setup();
    repository.createStudentSession({ id: 'expired' as never, studentId: 'student-1' as StudentId, classId: 'class-1' as ClassId, tokenHash: 'old', createdAtUtc: '2026-09-06T00:00:00.000Z' as never, lastSeenAtUtc: '2026-09-06T00:00:00.000Z' as never, absoluteExpiresAtUtc: '2026-09-06T12:00:00.000Z' as never, idleExpiresAtUtc: '2026-09-06T02:00:00.000Z' as never, revokedAtUtc: null });
    repository.createStudentSession({ id: 'replacement' as never, studentId: 'student-1' as StudentId, classId: 'class-1' as ClassId, tokenHash: 'new', createdAtUtc: '2026-09-07T00:00:00.000Z' as never, lastSeenAtUtc: '2026-09-07T00:00:00.000Z' as never, absoluteExpiresAtUtc: '2026-09-07T12:00:00.000Z' as never, idleExpiresAtUtc: '2026-09-07T02:00:00.000Z' as never, revokedAtUtc: null });
    expect(database?.prepare('SELECT revoked_at_utc FROM student_sessions WHERE id=?').get('expired')).toMatchObject({ revoked_at_utc: expect.any(String) });
  });

  it('closes atomically, snapshots no-answer rows, and rejects reopen', () => {
    const repository = setup();
    repository.createQuestion(teacher, { id: 'q1' as never, classId: 'class-1' as ClassId, kind: 'single_choice', prompt: 'Pick', options: [{ key: 'a', label: 'A' }] });
    repository.transitionQuestion(teacher, 'q1' as never, 'open');
    repository.submitAnswer(studentContext('student-1'), { questionId: 'q1' as never, revision: 1, idempotencyKey: 'key-1', requestFingerprint: 'request-1', payload: { kind: 'single_choice', selectedOptions: ['a'] } });
    const snapshot = repository.closeQuestion(teacher, 'q1' as never);
    expect(snapshot.counts).toEqual({ a: 1 });
    expect(repository.answerAtClose('q1' as never, 'student-2' as never)?.noAnswer).toBe(true);
    expect(() => repository.transitionQuestion(teacher, 'q1' as never, 'open')).toThrow('Invalid lifecycle transition');
  });

  it('rolls back a multi-row question insert when an option constraint fails', () => {
    const repository = setup();
    expect(() => repository.createQuestion(teacher, { id: 'rolled-back' as never, classId: 'class-1' as ClassId, kind: 'single_choice', prompt: 'Pick', options: [{ key: 'same', label: 'A' }, { key: 'same', label: 'B' }] })).toThrow();
    expect(database?.prepare('SELECT id FROM questions WHERE id=?').get('rolled-back')).toBeUndefined();
  });

  it('keeps late answers separate and replays an idempotent result immutably', () => {
    const repository = setup();
    repository.createQuestion(teacher, { id: 'q2' as never, classId: 'class-1' as ClassId, kind: 'short_text', prompt: 'Why?', options: [] });
    repository.transitionQuestion(teacher, 'q2' as never, 'open');
    const input = { questionId: 'q2' as never, revision: 1, idempotencyKey: 'same-key', requestFingerprint: 'same-request', payload: { kind: 'short_text' as const, text: 'on time' } };
    const first = repository.submitAnswer(studentContext('student-1'), input);
    expect(repository.submitAnswer(studentContext('student-1'), input)).toEqual(first);
    repository.closeQuestion(teacher, 'q2' as never);
    repository.submitAnswer(studentContext('student-1'), { ...input, revision: 2, idempotencyKey: 'late-key', requestFingerprint: 'late-request', payload: { kind: 'short_text', text: 'late' } });
    expect(repository.answerAtClose('q2' as never, 'student-1' as never)?.payload).toEqual({ kind: 'short_text', text: 'on time' });
    expect(() => repository.submitAnswer(studentContext('student-1'), { ...input, requestFingerprint: 'different' })).toThrow('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST');
  });

  it('physically deletes answer payloads while preserving the anonymous snapshot and audit marker', () => {
    const repository = setup();
    repository.createQuestion(teacher, { id: 'q3' as never, classId: 'class-1' as ClassId, kind: 'single_choice', prompt: 'Pick', options: [{ key: 'a', label: 'A' }] });
    repository.transitionQuestion(teacher, 'q3' as never, 'open');
    repository.submitAnswer(studentContext('student-1'), { questionId: 'q3' as never, revision: 1, idempotencyKey: 'delete-key', requestFingerprint: 'delete-request', payload: { kind: 'single_choice', selectedOptions: ['a'] } });
    const snapshot = repository.closeQuestion(teacher, 'q3' as never);
    repository.deleteAnswer(teacher, 'q3' as never, 'student-1' as never, { confirmed: true, impactAcknowledged: true });
    expect(repository.answerAtClose('q3' as never, 'student-1' as never)).toBeUndefined();
    expect(snapshot.counts).toEqual({ a: 1 });
    expect(database?.prepare('SELECT deleted_at_utc FROM answer_deletion_markers WHERE question_id=? AND student_id=?').get('q3', 'student-1')).toBeDefined();
  });
});
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
