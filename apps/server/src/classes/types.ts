import type { Class, ClassId, PendingStudentRequest, PendingStudentRequestId, Student, StudentId } from '../domain/types.js';

export type ClassSummary = Readonly<Pick<Class, 'id' | 'name'>>;
export type RosterEntry = Readonly<{
  displayName: string;
  rawStudentNumber: string;
  normalizedStudentNumber: string;
}>;
export type CsvIssue = Readonly<{ line: number; message: string }>;
export type CsvPreview = Readonly<{
  rows: readonly RosterEntry[];
  issues: readonly CsvIssue[];
  /** Rows whose columns after 學號 and 姓名 are deliberately not stored. */
  ignoredColumnLines?: readonly number[];
}>;
export type JoinResult =
  /** A student-number login always resolves to a class member.  Existing
   * roster records are reused so old course data continues to work. */
  Readonly<{ outcome: 'joined'; student: Student; created: boolean }>;

/** Integration supplies a session/CSRF-aware implementation. This bounded service never treats a pending request as a teacher. */
export interface TeacherAuthorization {
  assertAuthorized(context: unknown): void;
}

export type ClassRosterRepository = Readonly<{
  listClasses: () => readonly ClassSummary[];
  createClass: (input: Class) => void;
  deleteClass: (classId: ClassId) => void;
  classExists: (classId: ClassId) => boolean;
  hasStudentNumber: (classId: ClassId, normalizedStudentNumber: string) => boolean;
  findStudentByNumber: (classId: ClassId, normalizedStudentNumber: string) => Student | undefined;
  findStudentByRosterIdentity: (classId: ClassId, displayName: string, normalizedStudentNumber: string) => Student | undefined;
  findPendingRequest: (classId: ClassId, normalizedStudentNumber: string) => PendingStudentRequest | undefined;
  createOrGetPendingRequest: (input: PendingStudentRequest) => PendingStudentRequest;
  importRoster: (classId: ClassId, entries: readonly RosterEntry[], createStudentId: () => StudentId, approvedAtUtc: string) => void;
  approvePendingRequest: (requestId: PendingStudentRequestId, createStudentId: () => StudentId, approvedAtUtc: string) => Student;
  /** Atomically inserts a number-only class member unless it already exists. */
  createStudentIfAbsent: (input: Student) => Readonly<{ student: Student; created: boolean }>;
  /** Durable membership telemetry for the teacher dashboard. */
  recordStudentJoin: (student: Student, atUtc: string) => void;
}>;
