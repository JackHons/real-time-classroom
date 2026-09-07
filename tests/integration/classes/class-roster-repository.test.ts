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

  it('atomically rechecks pending approval and preserves a conflict without authorization', () => {
    const subject = setup();
    const classroom = subject.createClass('teacher', '1A');
    const join = subject.requestJoin(classroom.id, 'Unauthorised', 'S1');
    if (join.outcome !== 'pending') throw new Error('test setup');
    database?.prepare('INSERT INTO students (id,class_id,display_name,raw_student_number,normalized_student_number,is_temporary,approved_at_utc) VALUES (?,?,?,?,?,?,?)').run('concurrent-roster', classroom.id, 'Roster', 'S1', 'S1', 0, '2026-09-07T00:00:00.000Z');
    expect(() => subject.approvePendingRequest('teacher', join.request.id)).toThrow('PENDING_APPROVAL_STUDENT_NUMBER_CONFLICT');
    expect(database?.prepare('SELECT status FROM pending_student_requests WHERE id=?').get(join.request.id)).toEqual({ status: 'pending' });
    expect(() => database?.prepare("INSERT INTO pending_student_requests (id,class_id,display_name,raw_student_number,normalized_student_number,requested_at_utc,status,resolved_at_utc) VALUES (?,?,?,?,?,?, 'pending',NULL)").run('duplicate', classroom.id, 'Other', 'S1', 'S1', 'now')).toThrow();
  });

  it('creates exactly one pending request under repeated joins, never a student or session', () => {
    const subject = setup();
    const classroom = subject.createClass('teacher', '1A');
    const first = subject.requestJoin(classroom.id, 'Guest', 'G1');
    const second = subject.requestJoin(classroom.id, 'Guest 2', 'g1');
    expect(first).toEqual(second);
    expect(database?.prepare('SELECT count(*) AS count FROM pending_student_requests').get()).toEqual({ count: 1 });
    expect(database?.prepare('SELECT count(*) AS count FROM students').get()).toEqual({ count: 0 });
    expect(database?.prepare('SELECT count(*) AS count FROM student_sessions').get()).toEqual({ count: 0 });
  });
});
