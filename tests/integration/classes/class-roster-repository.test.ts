import { afterEach, describe, expect, it } from 'vitest';
import { ClassService } from '../../../apps/server/src/classes/class-service.js';
import { SqliteClassRosterRepository } from '../../../apps/server/src/db/class-roster-repository.js';
import { openSqlite, type SqliteDatabase } from '../../../apps/server/src/db/connection.js';
import { migrate } from '../../../apps/server/src/db/migrator.js';
import type { ClassId, PendingStudentRequestId, StudentId } from '../../../apps/server/src/domain/types.js';

let database: SqliteDatabase | undefined;
let nextId = 0;

function setup(): ClassService {
  database = openSqlite(':memory:');
  migrate(database);
  return new ClassService({
    repository: new SqliteClassRosterRepository(database),
    teacherAuthorization: { assertAuthorized(context) { if (context !== 'teacher') throw new Error('TEACHER_AUTH_REQUIRED'); } },
    now: () => '2026-09-07T00:00:00.000Z',
    createClassId: () => `class-${++nextId}` as ClassId,
    createStudentId: () => `student-${++nextId}` as StudentId,
    createPendingRequestId: () => `pending-${++nextId}` as PendingStudentRequestId
  });
}

afterEach(() => { database?.close(); database = undefined; nextId = 0; });

describe('SQLite class roster repository', () => {
  it('uses schema unique constraints and all-or-nothing CSV imports', () => {
    const subject = setup();
    const classroom = subject.createClass('teacher', '1A');
    const invalid = subject.importRosterCsv('teacher', classroom.id, '姓名,學號\nAda,A1\nBen,a1');
    expect(invalid.issues).toHaveLength(1);
    expect(database?.prepare('SELECT count(*) AS count FROM students').get()).toEqual({ count: 0 });
    subject.importRosterCsv('teacher', classroom.id, '姓名,學號\nAda,A1');
    const conflict = subject.importRosterCsv('teacher', classroom.id, '姓名,學號\nBen,a1\nCara,C3');
    expect(conflict.issues).toEqual([{ line: 2, message: '學號已存在於班級名單' }]);
    expect(database?.prepare('SELECT count(*) AS count FROM students').get()).toEqual({ count: 1 });
  });

  it('creates a durable number-only member without using pending approval', () => {
    const subject = setup();
    const classroom = subject.createClass('teacher', '1A');
    const join = subject.requestJoin(classroom.id, 'S1');
    expect(join).toMatchObject({ outcome: 'joined', created: true, student: { normalizedStudentNumber: 'S1' } });
    expect(database?.prepare('SELECT count(*) AS count FROM student_class_joins').get()).toEqual({ count: 1 });
    expect(database?.prepare('SELECT count(*) AS count FROM pending_student_requests').get()).toEqual({ count: 0 });
  });

  it('reuses one number-only member under repeated joins and records the class entry', () => {
    const subject = setup();
    const classroom = subject.createClass('teacher', '1A');
    const first = subject.requestJoin(classroom.id, 'G1');
    const second = subject.requestJoin(classroom.id, 'g1');
    expect(first).toMatchObject({ outcome: 'joined', created: true });
    expect(second).toMatchObject({ outcome: 'joined', created: false });
    expect(database?.prepare('SELECT count(*) AS count FROM pending_student_requests').get()).toEqual({ count: 0 });
    expect(database?.prepare('SELECT count(*) AS count FROM students').get()).toEqual({ count: 1 });
    expect(database?.prepare('SELECT count(*) AS count FROM student_class_joins').get()).toEqual({ count: 1 });
    expect(database?.prepare('SELECT count(*) AS count FROM student_sessions').get()).toEqual({ count: 0 });
  });
});
