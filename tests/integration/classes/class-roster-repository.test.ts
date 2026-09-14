import { afterEach, describe, expect, it } from 'vitest';
import { ClassService } from '../../../apps/server/src/classes/class-service.js';
import { reconcileClassDeletionCleanup, SqliteClassRosterRepository } from '../../../apps/server/src/db/class-roster-repository.js';
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

  it('journals generated material, submission and staging objects before atomically cascading one class', async () => {
    const subject = setup();
    const first = subject.createClass('teacher', '1A'); const second = subject.createClass('teacher', '1B');
    const joined = subject.requestJoin(first.id, 'S1').student;
    database?.prepare("INSERT INTO file_submission_tasks (id,class_id,title,description,state,max_bytes,deadline_at_utc,opened_at_utc,closed_at_utc,created_at_utc,updated_at_utc) VALUES ('task',?,'T','', 'closed',100000000,'2026-10-01T00:00:00.000Z',NULL,NULL,'2026-09-07T00:00:00.000Z','2026-09-07T00:00:00.000Z')").run(first.id);
    database?.prepare("INSERT INTO file_submissions (id,task_id,student_id,original_filename,display_filename,storage_key,declared_mime_type,byte_length,sha256,received_complete_at_utc,deleted_at_utc) VALUES ('submission','task',?,'a.txt','a.txt','11111111-1111-4111-8111-111111111111','text/plain',1,?, '2026-09-07T00:00:00.000Z',NULL)").run(joined.id, 'a'.repeat(64));
    database?.prepare("INSERT INTO upload_sessions (id,task_id,student_id,idempotency_key,state,staging_key,final_storage_key,bytes_received,sha256,received_complete_at_utc,error_code,created_at_utc,updated_at_utc) VALUES ('upload','task',?,'k','failed','staging/22222222-2222-4222-8222-222222222222.part',NULL,0,NULL,NULL,NULL,'2026-09-07T00:00:00.000Z','2026-09-07T00:00:00.000Z')").run(joined.id);
    database?.prepare("INSERT INTO class_materials (id,class_id,display_filename,declared_mime_type,byte_length,sha256,storage_key,created_at_utc) VALUES ('material',?,'m.txt','text/plain',1,?,'33333333-3333-4333-8333-333333333333','2026-09-07T00:00:00.000Z')").run(first.id, 'b'.repeat(64));
    expect(subject.classDeletionImpact('teacher', first.id)).toMatchObject({ className: '1A', students: 1, joinedStudents: 1, materials: 1, fileTasks: 1, submissions: 1 });
    subject.deleteClass('teacher', first.id, { confirmationName: '1A', impactAcknowledged: true });
    expect(database?.prepare('SELECT count(*) AS count FROM classes').get()).toEqual({ count: 1 });
    expect(database?.prepare('SELECT id FROM classes').get()).toEqual({ id: second.id });
    expect(database?.prepare('SELECT count(*) AS count FROM students').get()).toEqual({ count: 0 });
    expect(database?.prepare('SELECT count(*) AS count FROM file_submissions').get()).toEqual({ count: 0 });
    const removed: string[] = [];
    const result = await reconcileClassDeletionCleanup(database!, { removeFinal: async (key: string) => { removed.push(`f:${key}`); }, removeStaging: async (key: string | null) => { removed.push(`s:${key}`); } });
    expect(result).toEqual({ cleaned: 3, failed: 0 });
    expect(removed.sort()).toEqual(['f:11111111-1111-4111-8111-111111111111', 'f:33333333-3333-4333-8333-333333333333', 's:staging/22222222-2222-4222-8222-222222222222.part']);
    expect(database?.prepare('SELECT count(*) AS count FROM class_deletion_cleanup').get()).toEqual({ count: 0 });
  });
});
