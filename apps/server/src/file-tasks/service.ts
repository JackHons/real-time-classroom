import { randomUUID } from 'node:crypto';
import type { AuthorizedStudentContext, ClassId, DeleteConfirmation, FileSubmission, FileSubmissionTask, FileSubmissionTaskId, IsoUtc, StudentId } from '../domain/types.js';
import { FILE_TASK_MAX_BYTES, type FileStoragePort, type FileStudentAuthorization, type FileTaskDraftInput, type FileTaskRepository, type FileTeacherAuthorization, type NewFileSubmission, type StudentTaskView, type TeacherClosedTaskView, type TeacherOpenTaskView } from './types.js';

const MAX_TITLE = 300;
const MAX_DESCRIPTION = 8_000;

export type FileTaskServiceDependencies = Readonly<{
  repository: FileTaskRepository;
  storage: FileStoragePort;
  teacherAuthorization: FileTeacherAuthorization;
  studentAuthorization: FileStudentAuthorization;
  classExists?: (classId: ClassId) => boolean;
  now?: () => Date;
  createTaskId?: () => FileSubmissionTaskId;
}>;

/** State and authorization boundary for metadata; it never consumes file bytes. */
export class FileTaskService {
  private readonly now: () => Date;
  private readonly createTaskId: () => FileSubmissionTaskId;
  constructor(private readonly dependencies: FileTaskServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.createTaskId = dependencies.createTaskId ?? (() => randomUUID() as FileSubmissionTaskId);
  }

  createDraft(context: unknown, classId: ClassId, input: FileTaskDraftInput): FileSubmissionTask {
    this.teacher(context);
    if (this.dependencies.classExists !== undefined && !this.dependencies.classExists(classId)) fail('CLASS_NOT_FOUND');
    const fields = validate(input);
    return this.dependencies.repository.createTask({ id: this.createTaskId(), classId, ...fields, state: 'draft', maxBytes: FILE_TASK_MAX_BYTES, openedAtUtc: null, closedAtUtc: null });
  }

  updateDraft(context: unknown, taskId: FileSubmissionTaskId, input: FileTaskDraftInput): FileSubmissionTask {
    this.teacher(context);
    const task = required(this.dependencies.repository.task(taskId));
    if (task.state !== 'draft') fail('FILE_TASK_TRANSITION_CONFLICT');
    return this.dependencies.repository.updateDraft(taskId, validate(input)) ?? fail('FILE_TASK_NOT_FOUND');
  }

  open(context: unknown, taskId: FileSubmissionTaskId): FileSubmissionTask {
    this.teacher(context);
    const task = required(this.dependencies.repository.task(taskId));
    if (task.state !== 'draft') fail('FILE_TASK_TRANSITION_CONFLICT');
    if (Date.parse(task.deadlineAtUtc) <= this.now().valueOf()) fail('FILE_TASK_DEADLINE_PASSED');
    return this.dependencies.repository.openTask(taskId, iso(this.now())) ?? fail('FILE_TASK_TRANSITION_CONFLICT');
  }

  close(context: unknown, taskId: FileSubmissionTaskId): FileSubmissionTask {
    this.teacher(context);
    const task = this.reconcile(taskId);
    if (task.state !== 'open') fail('FILE_TASK_TRANSITION_CONFLICT');
    return this.dependencies.repository.closeTask(taskId, iso(this.now())) ?? fail('FILE_TASK_TRANSITION_CONFLICT');
  }

  readForTeacher(context: unknown, taskId: FileSubmissionTaskId): TeacherOpenTaskView | TeacherClosedTaskView {
    this.teacher(context);
    const task = this.reconcile(taskId);
    return task.state === 'closed'
      ? { task, submissions: this.dependencies.repository.closedSubmissions(taskId) }
      : { task, completion: this.dependencies.repository.completion(taskId) };
  }

  readForStudent(context: unknown, taskId: FileSubmissionTaskId): StudentTaskView {
    const student = this.student(context);
    const task = this.studentTask(taskId, student);
    const submission = this.dependencies.repository.studentSubmission(taskId, student.studentId);
    return { task: { ...task, maxBytes: FILE_TASK_MAX_BYTES }, submission: submission === undefined ? { submitted: false } : { submitted: true, submittedAtUtc: submission.receivedCompleteAtUtc, displayFilename: submission.displayFilename, byteLength: submission.byteLength } };
  }

  prepareSubmission(context: unknown, taskId: FileSubmissionTaskId): FileSubmissionTask {
    const student = this.student(context);
    const task = this.studentTask(taskId, student);
    if (task.state !== 'open') fail('FILE_TASK_CLOSED');
    if (this.dependencies.repository.studentSubmission(taskId, student.studentId) !== undefined) fail('FILE_SUBMISSION_ALREADY_EXISTS');
    return task;
  }

  commitSubmission(context: unknown, input: Omit<NewFileSubmission, 'studentId'>): FileSubmission {
    const student = this.student(context);
    const task = this.studentTask(input.taskId, student);
    validateCommittedSubmission(input, task);
    if (this.dependencies.repository.studentSubmission(input.taskId, student.studentId) !== undefined) fail('FILE_SUBMISSION_ALREADY_EXISTS');
    try { return this.dependencies.repository.createSubmission({ ...input, studentId: student.studentId }); }
    catch (error) { if (isConstraint(error)) fail('FILE_SUBMISSION_ALREADY_EXISTS'); throw error; }
  }

  deleteSubmission(context: unknown, taskId: FileSubmissionTaskId, studentId: StudentId, confirmation: DeleteConfirmation): void {
    this.teacher(context); confirmed(confirmation);
    required(this.dependencies.repository.task(taskId));
    const submission = this.dependencies.repository.studentSubmission(taskId, studentId);
    if (submission === undefined) return; // confirmed deletes are deliberately idempotent
    const operation = this.dependencies.storage.stageDeletion([{ storageKey: submission.storageKey, submissionId: submission.id }]);
    let marked = false;
    try {
      const deleted = this.dependencies.repository.markSubmissionDeleted(taskId, studentId, iso(this.now()));
      if (deleted === undefined) return;
      marked = true;
      operation.commit();
    } catch (error) {
      try { operation.rollback(); } finally { if (marked) this.dependencies.repository.restoreSubmission(submission.id); }
      throw error;
    }
  }

  deleteTask(context: unknown, taskId: FileSubmissionTaskId, confirmation: DeleteConfirmation): void {
    this.teacher(context); confirmed(confirmation);
    required(this.dependencies.repository.task(taskId));
    // A task is only physically deletable after each submitted object has been
    // removed through deleteSubmission's reversible storage protocol.
    if (!this.dependencies.repository.deleteEmptyTask(taskId)) fail('FILE_TASK_HAS_SUBMISSIONS');
  }

  private studentTask(taskId: FileSubmissionTaskId, student: AuthorizedStudentContext): FileSubmissionTask {
    const task = this.reconcile(taskId);
    // Missing, draft and foreign-class tasks deliberately share one result.
    if (task.classId !== student.classId || task.state === 'draft') fail('FILE_TASK_NOT_FOUND');
    return task;
  }
  private reconcile(taskId: FileSubmissionTaskId): FileSubmissionTask {
    const task = required(this.dependencies.repository.task(taskId));
    if (task.state === 'open' && Date.parse(task.deadlineAtUtc) <= this.now().valueOf()) {
      return this.dependencies.repository.closeTask(taskId, iso(this.now())) ?? required(this.dependencies.repository.task(taskId));
    }
    return task;
  }
  private teacher(context: unknown): void { this.dependencies.teacherAuthorization.assertAuthorized(context); }
  private student(context: unknown): AuthorizedStudentContext { return this.dependencies.studentAuthorization.assertAuthorized(context); }
}

function validate(input: FileTaskDraftInput): Pick<FileSubmissionTask, 'title' | 'description' | 'deadlineAtUtc'> {
  const title = normalized(input.title, MAX_TITLE, 'FILE_TASK_TITLE');
  const description = normalized(input.description, MAX_DESCRIPTION, 'FILE_TASK_DESCRIPTION', true);
  if (typeof input.deadlineAtUtc !== 'string' || !Number.isFinite(Date.parse(input.deadlineAtUtc))) fail('FILE_TASK_DEADLINE_INVALID');
  return { title, description, deadlineAtUtc: input.deadlineAtUtc as IsoUtc };
}
function validateCommittedSubmission(input: Omit<NewFileSubmission, 'studentId'>, task: FileSubmissionTask): void {
  if (input.byteLength < 0 || input.byteLength > FILE_TASK_MAX_BYTES || !Number.isSafeInteger(input.byteLength)) fail('FILE_SUBMISSION_SIZE_INVALID');
  if (!/^[a-f0-9]{64}$/i.test(input.sha256)) fail('FILE_SUBMISSION_HASH_INVALID');
  if (normalized(input.originalFilename, 512, 'FILE_SUBMISSION_FILENAME').length === 0 || normalized(input.displayFilename, 512, 'FILE_SUBMISSION_FILENAME').length === 0 || normalized(input.storageKey, 1_000, 'FILE_SUBMISSION_STORAGE_KEY').length === 0) fail('FILE_SUBMISSION_INVALID');
  if (input.declaredMimeType !== null && (typeof input.declaredMimeType !== 'string' || input.declaredMimeType.length > 255)) fail('FILE_SUBMISSION_MIME_INVALID');
  // Completion, not client upload start, is authoritative: no last-byte race past close.
  if (task.state !== 'open' || Date.parse(task.deadlineAtUtc) <= Date.parse(input.receivedCompleteAtUtc)) fail('FILE_TASK_CLOSED');
}
function normalized(value: unknown, maximum: number, code: string, allowEmpty = false): string { if (typeof value !== 'string') fail(`${code}_REQUIRED`); const result = value.normalize('NFKC').trim(); if ((!allowEmpty && result.length === 0) || result.length > maximum) fail(`${code}_INVALID`); return result; }
function required(value: FileSubmissionTask | undefined): FileSubmissionTask { return value ?? fail('FILE_TASK_NOT_FOUND'); }
function confirmed(value: DeleteConfirmation): void { if (value.confirmed !== true || value.impactAcknowledged !== true) fail('DELETE_CONFIRMATION_REQUIRED'); }
function iso(date: Date): IsoUtc { return date.toISOString() as IsoUtc; }
function fail(code: string): never { throw new Error(code); }
function isConstraint(error: unknown): boolean { return error instanceof Error && /constraint|unique/i.test(error.message); }
