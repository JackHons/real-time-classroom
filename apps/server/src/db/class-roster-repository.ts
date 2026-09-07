import type { Class, ClassId, IsoUtc, PendingStudentRequest, PendingStudentRequestId, Student, StudentId } from '../domain/types.js';
import type { ClassRosterRepository, ClassSummary, RosterEntry } from '../classes/types.js';
import type { SqliteDatabase } from './connection.js';

type StudentRow = Readonly<{ id: string; class_id: string; display_name: string; raw_student_number: string; normalized_student_number: string; is_temporary: number; approved_at_utc: string }>;
type PendingRow = Readonly<{ id: string; class_id: string; display_name: string; raw_student_number: string; normalized_student_number: string; requested_at_utc: string; status: 'pending' | 'approved' | 'rejected' }>;

export class SqliteClassRosterRepository implements ClassRosterRepository {
  constructor(private readonly database: SqliteDatabase) {}

  listClasses(): readonly ClassSummary[] {
    return (this.database.prepare('SELECT id,name FROM classes ORDER BY name,id').all() as readonly { id: string; name: string }[])
      .map((row) => ({ id: row.id as ClassId, name: row.name }));
  }

  createClass(input: Class): void {
    this.database.prepare('INSERT INTO classes (id,name,created_at_utc,updated_at_utc) VALUES (?,?,?,?)').run(input.id, input.name, input.createdAtUtc, input.updatedAtUtc);
  }

  deleteClass(classId: ClassId): void {
    const result = this.database.prepare('DELETE FROM classes WHERE id=?').run(classId);
    if (result.changes !== 1) throw new Error('CLASS_NOT_FOUND');
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
