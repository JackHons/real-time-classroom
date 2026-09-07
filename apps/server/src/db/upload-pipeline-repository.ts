import type { UploadSessionId } from '../domain/types.js';
import type { SqliteDatabase } from './connection.js';
import type { ReconciliationRecord, UploadPipelineRepository, UploadStart, UploadTaskPolicy } from '../uploads/types.js';

type TaskRow = Readonly<{ deadline_at_utc: string; max_bytes: number }>;
type RecoveryRow = Readonly<{ id: string; state: ReconciliationRecord['state']; staging_key: string | null; final_storage_key: string | null; bytes_received: number; sha256: string | null }>;

/** SQLite implementation of the narrow byte-pipeline persistence port. */
export class SqliteUploadPipelineRepository implements UploadPipelineRepository {
  constructor(private readonly database: SqliteDatabase, private readonly now: () => string = () => new Date().toISOString()) {}

  begin(input: UploadStart): UploadTaskPolicy {
    return this.database.transaction(() => {
      const task = this.database.prepare("SELECT deadline_at_utc,max_bytes FROM file_submission_tasks WHERE id=? AND state='open'").get(input.taskId) as TaskRow | undefined;
      if (task === undefined) throw new Error('FILE_TASK_NOT_OPEN');
      const member = this.database.prepare('SELECT 1 FROM students WHERE id=? AND class_id=(SELECT class_id FROM file_submission_tasks WHERE id=?)').get(input.studentId, input.taskId);
      if (member === undefined) throw new Error('FILE_UPLOAD_NOT_AUTHORIZED');
      // A teacher deletion soft-deletes the submission. Retire its old upload
      // session before a replacement, otherwise the historical partial unique
      // index would incorrectly block a legitimate resubmission.
      this.database.prepare("UPDATE upload_sessions SET state='failed',error_code='SUBMISSION_REPLACED_AFTER_DELETE',updated_at_utc=? WHERE task_id=? AND student_id=? AND state='metadata_committed' AND EXISTS (SELECT 1 FROM file_submissions WHERE file_submissions.id=upload_sessions.id AND file_submissions.deleted_at_utc IS NOT NULL)").run(this.now(), input.taskId, input.studentId);
      const committed = this.database.prepare('SELECT 1 FROM file_submissions WHERE task_id=? AND student_id=? AND deleted_at_utc IS NULL').get(input.taskId, input.studentId);
      if (committed !== undefined) throw new Error('FILE_SUBMISSION_ALREADY_EXISTS');
      const active = this.database.prepare("SELECT 1 FROM upload_sessions WHERE task_id=? AND student_id=? AND state IN ('staging','validating','file_committed','recovery_pending')").get(input.taskId, input.studentId);
      if (active !== undefined) throw new Error('FILE_UPLOAD_ALREADY_IN_PROGRESS');
      const at = this.now();
      this.database.prepare("INSERT INTO upload_sessions (id,task_id,student_id,idempotency_key,state,staging_key,final_storage_key,bytes_received,sha256,received_complete_at_utc,error_code,created_at_utc,updated_at_utc,original_filename,display_filename,declared_mime_type) VALUES (?,?,?,?, 'staging', ?,NULL,0,NULL,NULL,NULL,?,?,?,?,?)")
        .run(input.uploadSessionId, input.taskId, input.studentId, input.uploadSessionId, input.stagingKey, at, at, input.originalFilename, input.displayFilename, input.declaredMimeType);
      return { deadlineAtUtc: task.deadline_at_utc, maxBytes: task.max_bytes };
    })();
  }

  recordVerified(input: Readonly<{ uploadSessionId: UploadSessionId; bytesReceived: number; sha256: string; receivedCompleteAtUtc: string }>): void {
    const result = this.database.prepare("UPDATE upload_sessions SET state='validating',bytes_received=?,sha256=?,received_complete_at_utc=?,updated_at_utc=? WHERE id=? AND state='staging'")
      .run(input.bytesReceived, input.sha256, input.receivedCompleteAtUtc, this.now(), input.uploadSessionId);
    if (result.changes !== 1) throw new Error('UPLOAD_VERIFY_PRECONDITION_FAILED');
  }

  prepareFileCommit(input: Readonly<{ uploadSessionId: UploadSessionId; finalStorageKey: string }>): void {
    assertFinalStorageKey(input.finalStorageKey);
    const result = this.database.prepare("UPDATE upload_sessions SET state='file_committed',final_storage_key=?,updated_at_utc=? WHERE id=? AND state='validating'")
      .run(input.finalStorageKey, this.now(), input.uploadSessionId);
    if (result.changes !== 1) throw new Error('FILE_COMMIT_INTENT_PRECONDITION_FAILED');
  }

  commitAfterFileRename(input: Readonly<{ uploadSessionId: UploadSessionId; finalStorageKey: string }>): void {
    assertFinalStorageKey(input.finalStorageKey);
    this.database.transaction(() => {
      const row = this.database.prepare("SELECT task_id,student_id,original_filename,display_filename,declared_mime_type,bytes_received,sha256,received_complete_at_utc FROM upload_sessions WHERE id=? AND state IN ('file_committed','recovery_pending') AND final_storage_key=?").get(input.uploadSessionId, input.finalStorageKey) as Readonly<{ task_id: string; student_id: string; original_filename: string | null; display_filename: string | null; declared_mime_type: string | null; bytes_received: number; sha256: string | null; received_complete_at_utc: string | null }> | undefined;
      if (row === undefined || row.original_filename === null || row.display_filename === null || row.sha256 === null || row.received_complete_at_utc === null) throw new Error('FILE_METADATA_COMMIT_PRECONDITION_FAILED');
      const exists = this.database.prepare('SELECT 1 FROM file_submissions WHERE task_id=? AND student_id=? AND deleted_at_utc IS NULL').get(row.task_id, row.student_id);
      if (exists === undefined) {
        this.database.prepare('INSERT INTO file_submissions (id,task_id,student_id,original_filename,display_filename,storage_key,declared_mime_type,byte_length,sha256,received_complete_at_utc,deleted_at_utc) VALUES (?,?,?,?,?,?,?,?,?,?,NULL)')
          .run(input.uploadSessionId, row.task_id, row.student_id, row.original_filename, row.display_filename, input.finalStorageKey, row.declared_mime_type, row.bytes_received, row.sha256, row.received_complete_at_utc);
      }
      const updated = this.database.prepare("UPDATE upload_sessions SET state='metadata_committed',error_code=NULL,updated_at_utc=? WHERE id=? AND state IN ('file_committed','recovery_pending') AND final_storage_key=?").run(this.now(), input.uploadSessionId, input.finalStorageKey);
      if (updated.changes !== 1) throw new Error('FILE_METADATA_COMMIT_PRECONDITION_FAILED');
    })();
  }

  markRecoveryPending(uploadSessionId: UploadSessionId, errorCode: string): void {
    const result = this.database.prepare("UPDATE upload_sessions SET state='recovery_pending',error_code=?,updated_at_utc=? WHERE id=? AND state='file_committed' AND final_storage_key IS NOT NULL").run(errorCode, this.now(), uploadSessionId);
    if (result.changes !== 1) throw new Error('FILE_RECOVERY_PRECONDITION_FAILED');
  }

  markFailed(uploadSessionId: UploadSessionId, errorCode: string): void {
    const result = this.database.prepare("UPDATE upload_sessions SET state='failed',error_code=?,updated_at_utc=? WHERE id=? AND state IN ('staging','validating','file_committed','recovery_pending')").run(errorCode, this.now(), uploadSessionId);
    if (result.changes !== 1) throw new Error('FILE_UPLOAD_FAILURE_PRECONDITION_FAILED');
  }

  listForReconciliation(): readonly ReconciliationRecord[] {
    const rows = this.database.prepare("SELECT id,state,staging_key,final_storage_key,bytes_received,sha256 FROM upload_sessions WHERE state IN ('staging','validating','file_committed','recovery_pending','metadata_committed')").all() as readonly RecoveryRow[];
    return rows.map((row) => ({ uploadSessionId: row.id as UploadSessionId, state: row.state, stagingKey: row.staging_key, finalStorageKey: row.final_storage_key, bytesReceived: row.bytes_received, sha256: row.sha256 }));
  }
}

function assertFinalStorageKey(key: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(key)) throw new Error('INVALID_FINAL_STORAGE_KEY');
}
