import { randomUUID } from 'node:crypto';
import type { ClassId, FileSubmission, FileSubmissionId, FileSubmissionTask, FileSubmissionTaskId, IsoUtc, StudentId } from '../domain/types.js';
import type { FileTaskRepository, NewFileSubmission, TeacherClosedTaskView, TeacherOpenTaskView } from '../file-tasks/types.js';
import type { SqliteDatabase } from './connection.js';

type TaskRow = Readonly<{ id: string; class_id: string; title: string; description: string; state: FileSubmissionTask['state']; max_bytes: number; deadline_at_utc: string; opened_at_utc: string | null; closed_at_utc: string | null }>;
type SubmissionRow = Readonly<{ id: string; task_id: string; student_id: string; original_filename: string; display_filename: string; storage_key: string; declared_mime_type: string | null; byte_length: number; sha256: string; received_complete_at_utc: string; deleted_at_utc: string | null }>;

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
    const changed = this.database.prepare("UPDATE file_submission_tasks SET state='open',opened_at_utc=?,updated_at_utc=? WHERE id=? AND state='draft'").run(openedAtUtc, this.now(), taskId).changes;
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
    return this.database.prepare("DELETE FROM file_submission_tasks WHERE id=? AND NOT EXISTS (SELECT 1 FROM file_submissions WHERE task_id=? AND deleted_at_utc IS NULL)").run(taskId, taskId).changes === 1;
  }
}
function task(row: TaskRow): FileSubmissionTask { return { id: row.id as FileSubmissionTaskId, classId: row.class_id as ClassId, title: row.title, description: row.description, state: row.state, maxBytes: row.max_bytes as 100000000, deadlineAtUtc: row.deadline_at_utc as IsoUtc, openedAtUtc: row.opened_at_utc as IsoUtc | null, closedAtUtc: row.closed_at_utc as IsoUtc | null }; }
function submission(row: SubmissionRow): FileSubmission { return { id: row.id as FileSubmissionId, taskId: row.task_id as FileSubmissionTaskId, studentId: row.student_id as StudentId, originalFilename: row.original_filename, displayFilename: row.display_filename, storageKey: row.storage_key, declaredMimeType: row.declared_mime_type, byteLength: row.byte_length, sha256: row.sha256, receivedCompleteAtUtc: row.received_complete_at_utc as IsoUtc, deletedAtUtc: row.deleted_at_utc as IsoUtc | null }; }
function requireTask(value: FileSubmissionTask | undefined): FileSubmissionTask { if (value === undefined) throw new Error('FILE_TASK_NOT_FOUND'); return value; }
