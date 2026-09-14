import { randomUUID } from 'node:crypto';
import type { Class, ClassId, IsoUtc, PendingStudentRequest, PendingStudentRequestId, Student, StudentId } from '../domain/types.js';
import type { ClassDeletionImpact, ClassRosterRepository, ClassSummary, RosterEntry } from '../classes/types.js';
import type { SqliteDatabase } from './connection.js';
import type { UploadStorage } from '../uploads/storage.js';

type StudentRow = Readonly<{ id: string; class_id: string; display_name: string; raw_student_number: string; normalized_student_number: string; is_temporary: number; approved_at_utc: string }>;
type PendingRow = Readonly<{ id: string; class_id: string; display_name: string; raw_student_number: string; normalized_student_number: string; requested_at_utc: string; status: 'pending' | 'approved' | 'rejected' }>;
type CleanupRow = Readonly<{ id: string; object_kind: 'final' | 'staging'; storage_key: string }>;

export class SqliteClassRosterRepository implements ClassRosterRepository {
  constructor(private readonly database: SqliteDatabase) {}

  listClasses(): readonly ClassSummary[] {
    return (this.database.prepare('SELECT id,name FROM classes ORDER BY name,id').all() as readonly { id: string; name: string }[])
      .map((row) => ({ id: row.id as ClassId, name: row.name }));
  }

  createClass(input: Class): void {
    this.database.prepare('INSERT INTO classes (id,name,created_at_utc,updated_at_utc) VALUES (?,?,?,?)').run(input.id, input.name, input.createdAtUtc, input.updatedAtUtc);
  }

  classDeletionImpact(classId: ClassId): ClassDeletionImpact {
    const classroom = this.database.prepare('SELECT id,name FROM classes WHERE id=?').get(classId) as { id: string; name: string } | undefined;
    if (classroom === undefined) throw new Error('CLASS_NOT_FOUND');
    // Every statement is scoped by the selected class.  Counts are only used
    // for the explicit confirmation UI and never return student identifiers.
    const count = (sql: string): number => (this.database.prepare(sql).get(classId) as { count: number }).count;
    return {
      classId: classroom.id as ClassId, className: classroom.name,
      students: count('SELECT count(*) AS count FROM students WHERE class_id=?'),
      joinedStudents: count('SELECT count(*) AS count FROM student_class_joins WHERE class_id=?'),
      materials: count('SELECT count(*) AS count FROM class_materials WHERE class_id=?'),
      questions: count('SELECT count(*) AS count FROM questions WHERE class_id=?'),
      fileTasks: count('SELECT count(*) AS count FROM file_submission_tasks WHERE class_id=?'),
      submissions: count('SELECT count(*) AS count FROM file_submissions s JOIN file_submission_tasks t ON t.id=s.task_id WHERE t.class_id=?')
    };
  }

  deleteClass(classId: ClassId): void {
    this.database.transaction(() => {
      // Record cleanup *before* the FK cascade.  If Windows is restarted
      // between database commit and file removal, the independent cleanup
      // journal remains and startup completes it. Keys originate exclusively
      // from generated storage metadata; UploadStorage validates them again.
      const insert = this.database.prepare('INSERT OR IGNORE INTO class_deletion_cleanup (id,class_id,object_kind,storage_key,created_at_utc) VALUES (?,?,?,?,?)');
      const now = new Date().toISOString();
      const finals = this.database.prepare("SELECT DISTINCT storage_key FROM file_submissions WHERE task_id IN (SELECT id FROM file_submission_tasks WHERE class_id=?) UNION SELECT DISTINCT storage_key FROM class_materials WHERE class_id=? UNION SELECT DISTINCT final_storage_key AS storage_key FROM upload_sessions WHERE task_id IN (SELECT id FROM file_submission_tasks WHERE class_id=?) AND final_storage_key IS NOT NULL").all(classId, classId, classId) as readonly { storage_key: string }[];
      const staging = this.database.prepare("SELECT DISTINCT staging_key AS storage_key FROM upload_sessions WHERE task_id IN (SELECT id FROM file_submission_tasks WHERE class_id=?) AND staging_key IS NOT NULL").all(classId) as readonly { storage_key: string }[];
      for (const item of finals) insert.run(randomUUID(), classId, 'final', item.storage_key, now);
      for (const item of staging) insert.run(randomUUID(), classId, 'staging', item.storage_key, now);
      const result = this.database.prepare('DELETE FROM classes WHERE id=?').run(classId);
      if (result.changes !== 1) throw new Error('CLASS_NOT_FOUND');
    })();
  }

  classExists(classId: ClassId): boolean {
    return this.database.prepare('SELECT 1 FROM classes WHERE id=?').get(classId) !== undefined;
  }

  hasStudentNumber(classId: ClassId, normalizedStudentNumber: string): boolean {
    return this.database.prepare('SELECT 1 FROM students WHERE class_id=? AND normalized_student_number=?').get(classId, normalizedStudentNumber) !== undefined;
  }

  findStudentByRosterIdentity(classId: ClassId, displayName: string, normalizedStudentNumber: string): Student | undefined {
    const row = this.database.prepare('SELECT id,class_id,display_name,raw_student_number,normalized_student_number,is_temporary,approved_at_utc FROM students WHERE class_id=? AND display_name=? AND normalized_student_number=?').get(classId, displayName, normalizedStudentNumber) as StudentRow | undefined;
    return row === undefined ? undefined : student(row);
  }

  findStudentByNumber(classId: ClassId, normalizedStudentNumber: string): Student | undefined {
    const row = this.database.prepare('SELECT id,class_id,display_name,raw_student_number,normalized_student_number,is_temporary,approved_at_utc FROM students WHERE class_id=? AND normalized_student_number=?').get(classId, normalizedStudentNumber) as StudentRow | undefined;
    return row === undefined ? undefined : student(row);
  }

  findPendingRequest(classId: ClassId, normalizedStudentNumber: string): PendingStudentRequest | undefined {
    const row = this.database.prepare("SELECT id,class_id,display_name,raw_student_number,normalized_student_number,requested_at_utc,status FROM pending_student_requests WHERE class_id=? AND normalized_student_number=? AND status='pending'").get(classId, normalizedStudentNumber) as PendingRow | undefined;
    return row === undefined ? undefined : pending(row);
  }

  createOrGetPendingRequest(input: PendingStudentRequest): PendingStudentRequest {
    return this.database.transaction(() => {
      if (!this.classExists(input.classId)) throw new Error('CLASS_NOT_FOUND');
      const existing = this.findPendingRequest(input.classId, input.normalizedStudentNumber);
      if (existing !== undefined) return existing;
      try {
        this.database.prepare("INSERT INTO pending_student_requests (id,class_id,display_name,raw_student_number,normalized_student_number,requested_at_utc,status,resolved_at_utc) VALUES (?,?,?,?,?,?, 'pending',NULL)").run(input.id, input.classId, input.displayName, input.rawStudentNumber, input.normalizedStudentNumber, input.requestedAtUtc);
      } catch (error) {
        if (isConstraint(error)) {
          const concurrent = this.findPendingRequest(input.classId, input.normalizedStudentNumber);
          if (concurrent !== undefined) return concurrent;
        }
        throw error;
      }
      return input;
    })();
  }

  importRoster(classId: ClassId, entries: readonly RosterEntry[], createStudentId: () => StudentId, approvedAtUtc: string): void {
    this.database.transaction(() => {
      if (!this.classExists(classId)) throw new Error('CLASS_NOT_FOUND');
      const occupied = this.database.prepare('SELECT 1 FROM students WHERE class_id=? AND normalized_student_number=?');
      for (const entry of entries) if (occupied.get(classId, entry.normalizedStudentNumber) !== undefined) throw new Error('ROSTER_IMPORT_STUDENT_NUMBER_CONFLICT');
      const insert = this.database.prepare('INSERT INTO students (id,class_id,display_name,raw_student_number,normalized_student_number,is_temporary,approved_at_utc) VALUES (?,?,?,?,?,?,?)');
      try {
        for (const entry of entries) insert.run(createStudentId(), classId, entry.displayName, entry.rawStudentNumber, entry.normalizedStudentNumber, 0, approvedAtUtc);
      } catch (error) {
        if (isConstraint(error)) throw new Error('ROSTER_IMPORT_STUDENT_NUMBER_CONFLICT', { cause: error });
        throw error;
      }
    })();
  }

  approvePendingRequest(requestId: PendingStudentRequestId, createStudentId: () => StudentId, approvedAtUtc: string): Student {
    return this.database.transaction(() => {
      const request = this.database.prepare("SELECT id,class_id,display_name,raw_student_number,normalized_student_number,requested_at_utc,status FROM pending_student_requests WHERE id=? AND status='pending'").get(requestId) as PendingRow | undefined;
      if (request === undefined) throw new Error('PENDING_REQUEST_NOT_FOUND_OR_RESOLVED');
      const duplicate = this.database.prepare('SELECT id FROM students WHERE class_id=? AND normalized_student_number=?').get(request.class_id, request.normalized_student_number);
      if (duplicate !== undefined) throw new Error('PENDING_APPROVAL_STUDENT_NUMBER_CONFLICT');
      const created: Student = { id: createStudentId(), classId: request.class_id as ClassId, displayName: request.display_name, rawStudentNumber: request.raw_student_number, normalizedStudentNumber: request.normalized_student_number, isTemporary: true, approvedAtUtc: approvedAtUtc as IsoUtc };
      try {
        this.database.prepare('INSERT INTO students (id,class_id,display_name,raw_student_number,normalized_student_number,is_temporary,approved_at_utc) VALUES (?,?,?,?,?,?,?)').run(created.id, created.classId, created.displayName, created.rawStudentNumber, created.normalizedStudentNumber, 1, created.approvedAtUtc);
      } catch (error) {
        if (isConstraint(error)) throw new Error('PENDING_APPROVAL_STUDENT_NUMBER_CONFLICT', { cause: error });
        throw error;
      }
      const updated = this.database.prepare("UPDATE pending_student_requests SET status='approved',resolved_at_utc=? WHERE id=? AND status='pending'").run(approvedAtUtc, requestId);
      if (updated.changes !== 1) throw new Error('PENDING_APPROVAL_CONFLICT');
      return created;
    })();
  }

  createStudentIfAbsent(input: Student): Readonly<{ student: Student; created: boolean }> {
    return this.database.transaction(() => {
      if (!this.classExists(input.classId)) throw new Error('CLASS_NOT_FOUND');
      const existing = this.findStudentByNumber(input.classId, input.normalizedStudentNumber);
      if (existing !== undefined) return { student: existing, created: false };
      try {
        this.database.prepare('INSERT INTO students (id,class_id,display_name,raw_student_number,normalized_student_number,is_temporary,approved_at_utc) VALUES (?,?,?,?,?,?,?)').run(input.id, input.classId, input.displayName, input.rawStudentNumber, input.normalizedStudentNumber, Number(input.isTemporary), input.approvedAtUtc);
      } catch (error) {
        if (isConstraint(error)) {
          const concurrent = this.findStudentByNumber(input.classId, input.normalizedStudentNumber);
          if (concurrent !== undefined) return { student: concurrent, created: false };
        }
        throw error;
      }
      return { student: input, created: true };
    })();
  }

  recordStudentJoin(student: Student, atUtc: string): void {
    this.database.prepare('INSERT INTO student_class_joins (student_id,class_id,joined_at_utc,last_joined_at_utc) VALUES (?,?,?,?) ON CONFLICT(student_id) DO UPDATE SET last_joined_at_utc=excluded.last_joined_at_utc').run(student.id, student.classId, atUtc, atUtc);
  }
}

/**
 * Completes cleanup left by a committed class deletion.  A missing object is
 * success because UploadStorage removes by generated key with force semantics.
 * A failed item stays journaled, so restart retries it rather than leaking a
 * private file or trusting a user-controlled path.
 */
export async function reconcileClassDeletionCleanup(database: SqliteDatabase, storage: Pick<UploadStorage, 'removeFinal' | 'removeStaging'>): Promise<Readonly<{ cleaned: number; failed: number }>> {
  const rows = database.prepare('SELECT id,object_kind,storage_key FROM class_deletion_cleanup ORDER BY created_at_utc,id').all() as readonly CleanupRow[];
  let cleaned = 0; let failed = 0;
  for (const row of rows) {
    try {
      if (row.object_kind === 'final') await storage.removeFinal(row.storage_key);
      else await storage.removeStaging(row.storage_key);
      database.prepare('DELETE FROM class_deletion_cleanup WHERE id=?').run(row.id);
      cleaned += 1;
    } catch { failed += 1; }
  }
  return { cleaned, failed };
}

function student(row: StudentRow): Student {
  return { id: row.id as StudentId, classId: row.class_id as ClassId, displayName: row.display_name, rawStudentNumber: row.raw_student_number, normalizedStudentNumber: row.normalized_student_number, isTemporary: row.is_temporary === 1, approvedAtUtc: row.approved_at_utc as IsoUtc };
}

function pending(row: PendingRow): PendingStudentRequest {
  return { id: row.id as PendingStudentRequestId, classId: row.class_id as ClassId, displayName: row.display_name, rawStudentNumber: row.raw_student_number, normalizedStudentNumber: row.normalized_student_number, requestedAtUtc: row.requested_at_utc as IsoUtc, status: row.status };
}

function isConstraint(error: unknown): boolean {
  return error instanceof Error && /constraint/i.test(error.message);
}
