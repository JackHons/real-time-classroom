import { randomUUID } from 'node:crypto';
import type { ClassId, FileSubmission, FileSubmissionId, FileSubmissionTask, FileSubmissionTaskId, IsoUtc, StudentId } from '../domain/types.js';
import type { FileExportSubmission, FileTaskRepository, NewFileSubmission, TeacherClosedTaskView, TeacherOpenTaskView, TeacherTaskDashboard } from '../file-tasks/types.js';
import type { DeletionTombstone, UploadStorage } from '../uploads/storage.js';
import type { SqliteDatabase } from './connection.js';

type TaskRow = Readonly<{ id: string; class_id: string; title: string; description: string; state: FileSubmissionTask['state']; max_bytes: number; deadline_at_utc: string; opened_at_utc: string | null; closed_at_utc: string | null }>;
type SubmissionRow = Readonly<{ id: string; task_id: string; student_id: string; original_filename: string; display_filename: string; storage_key: string; declared_mime_type: string | null; byte_length: number; sha256: string; received_complete_at_utc: string; deleted_at_utc: string | null }>;
type DeletionRecoveryRow = Readonly<{ id: string; task_id: string; student_id: string; storage_key: string; deleted_at_utc: string | null }>;

/** SQLite adapter for Task 5's metadata tables. It has no byte-stream knowledge. */
export class SqliteFileSubmissionTaskRepository implements FileTaskRepository {
  constructor(private readonly database: SqliteDatabase, private readonly now: () => string = () => new Date().toISOString()) {}

  createTask(task: FileSubmissionTask): FileSubmissionTask {
    const now = this.now();
    this.database.prepare('INSERT INTO file_submission_tasks (id,class_id,title,description,state,max_bytes,deadline_at_utc,opened_at_utc,closed_at_utc,created_at_utc,updated_at_utc) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(task.id, task.classId, task.title, task.description, task.state, task.maxBytes, task.deadlineAtUtc, task.openedAtUtc, task.closedAtUtc, now, now);
    return requireTask(this.task(task.id));
  }
  task(taskId: FileSubmissionTaskId): FileSubmissionTask | undefined {
    const row = this.database.prepare('SELECT id,class_id,title,description,state,max_bytes,deadline_at_utc,opened_at_utc,closed_at_utc FROM file_submission_tasks WHERE id=?').get(taskId) as TaskRow | undefined;
    return row === undefined ? undefined : task(row);
  }
  updateDraft(taskId: FileSubmissionTaskId, input: Pick<FileSubmissionTask, 'title' | 'description' | 'deadlineAtUtc'>): FileSubmissionTask | undefined {
    const changed = this.database.prepare("UPDATE file_submission_tasks SET title=?,description=?,deadline_at_utc=?,updated_at_utc=? WHERE id=? AND state='draft'").run(input.title, input.description, input.deadlineAtUtc, this.now(), taskId).changes;
    return changed === 1 ? this.task(taskId) : undefined;
  }
  openTask(taskId: FileSubmissionTaskId, openedAtUtc: IsoUtc): FileSubmissionTask | undefined {
    const changed = this.database.prepare("UPDATE file_submission_tasks SET state='open',opened_at_utc=COALESCE(opened_at_utc,?),closed_at_utc=NULL,updated_at_utc=? WHERE id=? AND state IN ('draft','closed')").run(openedAtUtc, this.now(), taskId).changes;
    return changed === 1 ? this.task(taskId) : undefined;
  }
  closeTask(taskId: FileSubmissionTaskId, closedAtUtc: IsoUtc): FileSubmissionTask | undefined {
    const changed = this.database.prepare("UPDATE file_submission_tasks SET state='closed',closed_at_utc=?,updated_at_utc=? WHERE id=? AND state='open'").run(closedAtUtc, this.now(), taskId).changes;
    return changed === 1 ? this.task(taskId) : undefined;
  }
  completion(taskId: FileSubmissionTaskId): TeacherOpenTaskView['completion'] {
    const task = requireTask(this.task(taskId));
    const eligibleStudentCount = (this.database.prepare('SELECT count(*) AS count FROM students WHERE class_id=?').get(task.classId) as { count: number }).count;
    const submittedStudentCount = (this.database.prepare("SELECT count(*) AS count FROM file_submissions WHERE task_id=? AND deleted_at_utc IS NULL").get(taskId) as { count: number }).count;
    return { eligibleStudentCount, submittedStudentCount };
  }
  studentSubmission(taskId: FileSubmissionTaskId, studentId: StudentId): FileSubmission | undefined {
    const row = this.database.prepare('SELECT id,task_id,student_id,original_filename,display_filename,storage_key,declared_mime_type,byte_length,sha256,received_complete_at_utc,deleted_at_utc FROM file_submissions WHERE task_id=? AND student_id=? AND deleted_at_utc IS NULL').get(taskId, studentId) as SubmissionRow | undefined;
    return row === undefined ? undefined : submission(row);
  }
  closedSubmissions(taskId: FileSubmissionTaskId): TeacherClosedTaskView['submissions'] {
    const rows = this.database.prepare("SELECT s.id AS student_id,s.display_name,s.raw_student_number,f.display_filename,f.declared_mime_type,f.byte_length,f.sha256,f.received_complete_at_utc FROM students s LEFT JOIN file_submissions f ON f.student_id=s.id AND f.task_id=? AND f.deleted_at_utc IS NULL WHERE s.class_id=(SELECT class_id FROM file_submission_tasks WHERE id=?) ORDER BY s.normalized_student_number,s.id").all(taskId, taskId) as readonly Readonly<{ student_id: string; display_name: string; raw_student_number: string; display_filename: string | null; declared_mime_type: string | null; byte_length: number | null; sha256: string | null; received_complete_at_utc: string | null }>[];
    return rows.filter((row) => row.display_filename !== null && row.byte_length !== null && row.sha256 !== null && row.received_complete_at_utc !== null).map((row) => ({ studentId: row.student_id as StudentId, displayName: row.display_name, studentNumber: row.raw_student_number, displayFilename: row.display_filename!, declaredMimeType: row.declared_mime_type, byteLength: row.byte_length!, sha256: row.sha256!, receivedCompleteAtUtc: row.received_complete_at_utc! as IsoUtc }));
  }
  dashboard(taskId: FileSubmissionTaskId): TeacherTaskDashboard {
    const task = requireTask(this.task(taskId));
    const rows = this.database.prepare("SELECT s.id AS student_id,s.display_name,s.raw_student_number,f.display_filename,f.declared_mime_type,f.byte_length,f.sha256,f.received_complete_at_utc FROM students s LEFT JOIN file_submissions f ON f.student_id=s.id AND f.task_id=? AND f.deleted_at_utc IS NULL WHERE s.class_id=? ORDER BY s.normalized_student_number,s.id").all(taskId, task.classId) as readonly Readonly<{ student_id: string; display_name: string; raw_student_number: string; display_filename: string | null; declared_mime_type: string | null; byte_length: number | null; sha256: string | null; received_complete_at_utc: string | null }>[];
    const submissions = rows.filter((row) => row.display_filename !== null && row.byte_length !== null && row.sha256 !== null && row.received_complete_at_utc !== null).map((row) => ({ studentId: row.student_id as StudentId, displayName: row.display_name, studentNumber: row.raw_student_number, displayFilename: row.display_filename!, declaredMimeType: row.declared_mime_type, byteLength: row.byte_length!, sha256: row.sha256!, receivedCompleteAtUtc: row.received_complete_at_utc! as IsoUtc }));
    const missingStudents = rows.filter((row) => row.display_filename === null).map((row) => ({ studentId: row.student_id as StudentId, displayName: row.display_name, studentNumber: row.raw_student_number }));
    return { completion: { eligibleStudentCount: rows.length, submittedStudentCount: submissions.length }, submissions, missingStudents };
  }
  exportSubmissions(taskId: FileSubmissionTaskId): readonly FileExportSubmission[] {
    // Deliberately inner-join live metadata: deleted rows and roster members
    // without a verified submission can never enter an export.
    const rows = this.database.prepare("SELECT f.student_id,s.display_name,s.raw_student_number,f.original_filename,f.storage_key,f.byte_length,f.sha256 FROM file_submissions f JOIN students s ON s.id=f.student_id WHERE f.task_id=? AND f.deleted_at_utc IS NULL ORDER BY s.normalized_student_number,s.id").all(taskId) as readonly Readonly<{ student_id: string; display_name: string; raw_student_number: string; original_filename: string; storage_key: string; byte_length: number; sha256: string }>[];
    return rows.map((row) => ({ studentId: row.student_id as StudentId, displayName: row.display_name, studentNumber: row.raw_student_number, originalFilename: row.original_filename, storageKey: row.storage_key, byteLength: row.byte_length, sha256: row.sha256 }));
  }
  createSubmission(input: NewFileSubmission): FileSubmission {
    const id = randomUUID() as FileSubmissionId;
    this.database.prepare('INSERT INTO file_submissions (id,task_id,student_id,original_filename,display_filename,storage_key,declared_mime_type,byte_length,sha256,received_complete_at_utc,deleted_at_utc) VALUES (?,?,?,?,?,?,?,?,?,?,NULL)')
      .run(id, input.taskId, input.studentId, input.originalFilename, input.displayFilename, input.storageKey, input.declaredMimeType, input.byteLength, input.sha256, input.receivedCompleteAtUtc);
    return { id, ...input, deletedAtUtc: null };
  }
  markSubmissionDeleted(taskId: FileSubmissionTaskId, studentId: StudentId, deletedAtUtc: IsoUtc): FileSubmission | undefined {
    return this.database.transaction(() => {
      const current = this.studentSubmission(taskId, studentId);
      if (current === undefined) return undefined;
      const changed = this.database.prepare('UPDATE file_submissions SET deleted_at_utc=? WHERE id=? AND deleted_at_utc IS NULL').run(deletedAtUtc, current.id).changes;
      if (changed !== 1) return undefined;
      this.database.prepare('INSERT INTO file_deletion_markers (submission_id,task_id,student_id,deleted_at_utc,deletion_error_code) VALUES (?,?,?,?,NULL) ON CONFLICT(submission_id) DO UPDATE SET deleted_at_utc=excluded.deleted_at_utc,deletion_error_code=NULL').run(current.id, taskId, studentId, deletedAtUtc);
      return current;
    })();
  }
  restoreSubmission(submissionId: FileSubmissionId): void {
    this.database.transaction(() => {
      this.database.prepare('UPDATE file_submissions SET deleted_at_utc=NULL WHERE id=?').run(submissionId);
      this.database.prepare('DELETE FROM file_deletion_markers WHERE submission_id=?').run(submissionId);
    })();
  }
  deleteEmptyTask(taskId: FileSubmissionTaskId): boolean {
    // Every non-finalized session can own durable bytes.  A failed session is
    // only safe to cascade after reconciliation has cleared its staging key.
    return this.database.prepare("DELETE FROM file_submission_tasks WHERE id=? AND NOT EXISTS (SELECT 1 FROM file_submissions WHERE task_id=? AND deleted_at_utc IS NULL) AND NOT EXISTS (SELECT 1 FROM upload_sessions WHERE task_id=? AND (state IN ('queued','staging','validating','file_committed','metadata_committed','recovery_pending') OR staging_key IS NOT NULL OR final_storage_key IS NOT NULL))").run(taskId, taskId, taskId).changes === 1;
  }

  /**
   * Completes the filesystem half of interrupted deletions at startup. A live
   * metadata row wins (the object is restored); soft-deleted metadata wins only
   * after its tombstone is actually removed. Errors remain in the marker table
   * and leave the opaque tombstone in place for a later retry/manual recovery.
   */
  async reconcileDeletionTombstones(storage: Pick<UploadStorage, 'listDeletionTombstones' | 'restoreDeletionTombstone' | 'completeDeletionTombstone'>): Promise<Readonly<{ restored: number; completed: number; failed: number }>> {
    let restored = 0; let completed = 0; let failed = 0;
    for (const entry of await storage.listDeletionTombstones()) {
      const row = this.database.prepare('SELECT id,task_id,student_id,storage_key,deleted_at_utc FROM file_submissions WHERE id=?').get(entry.submissionId) as DeletionRecoveryRow | undefined;
      if (row === undefined || row.storage_key !== entry.storageKey) {
        this.recordDeletionFailure(entry, row, 'DELETION_TOMBSTONE_INTEGRITY_FAILED'); failed += 1; continue;
      }
      try {
        if (row.deleted_at_utc === null) {
          await storage.restoreDeletionTombstone(entry);
          this.clearDeletionFailure(row.id);
          restored += 1;
        } else {
          await storage.completeDeletionTombstone(entry);
          this.clearDeletionFailure(row.id);
          completed += 1;
        }
      } catch {
        this.recordDeletionFailure(entry, row, 'DELETION_PHYSICAL_DELETE_FAILED'); failed += 1;
      }
    }
    return { restored, completed, failed };
  }

  private clearDeletionFailure(submissionId: string): void { this.database.prepare('UPDATE file_deletion_markers SET deletion_error_code=NULL WHERE submission_id=?').run(submissionId); }
  private recordDeletionFailure(entry: DeletionTombstone, row: DeletionRecoveryRow | undefined, code: string): void {
    if (row === undefined) return; // Keep the opaque marker on disk; no trustworthy foreign key remains for a DB record.
    this.database.prepare('INSERT INTO file_deletion_markers (submission_id,task_id,student_id,deleted_at_utc,deletion_error_code) VALUES (?,?,?,?,?) ON CONFLICT(submission_id) DO UPDATE SET deletion_error_code=excluded.deletion_error_code')
      .run(row.id, row.task_id, row.student_id, this.now(), code);
  }
}
function task(row: TaskRow): FileSubmissionTask { return { id: row.id as FileSubmissionTaskId, classId: row.class_id as ClassId, title: row.title, description: row.description, state: row.state, maxBytes: row.max_bytes as 100000000, deadlineAtUtc: row.deadline_at_utc as IsoUtc, openedAtUtc: row.opened_at_utc as IsoUtc | null, closedAtUtc: row.closed_at_utc as IsoUtc | null }; }
function submission(row: SubmissionRow): FileSubmission { return { id: row.id as FileSubmissionId, taskId: row.task_id as FileSubmissionTaskId, studentId: row.student_id as StudentId, originalFilename: row.original_filename, displayFilename: row.display_filename, storageKey: row.storage_key, declaredMimeType: row.declared_mime_type, byteLength: row.byte_length, sha256: row.sha256, receivedCompleteAtUtc: row.received_complete_at_utc as IsoUtc, deletedAtUtc: row.deleted_at_utc as IsoUtc | null }; }
function requireTask(value: FileSubmissionTask | undefined): FileSubmissionTask { if (value === undefined) throw new Error('FILE_TASK_NOT_FOUND'); return value; }
