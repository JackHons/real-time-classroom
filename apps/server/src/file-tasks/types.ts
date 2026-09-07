import type { IncomingMessage } from 'node:http';
import type { AuthorizedStudentContext, ClassId, DeleteConfirmation, FileSubmission, FileSubmissionId, FileSubmissionTask, FileSubmissionTaskId, IsoUtc, StudentId } from '../domain/types.js';

export const FILE_TASK_MAX_BYTES = 100_000_000 as const;

export type FileTaskDraftInput = Readonly<{ title: string; description: string; deadlineAtUtc: string }>;
export type NewFileSubmission = Readonly<{
  taskId: FileSubmissionTaskId;
  studentId: StudentId;
  originalFilename: string;
  displayFilename: string;
  storageKey: string;
  declaredMimeType: string | null;
  byteLength: number;
  sha256: string;
  receivedCompleteAtUtc: IsoUtc;
}>;

export type SubmissionStatus = Readonly<{ submitted: boolean; submittedAtUtc?: IsoUtc; displayFilename?: string; byteLength?: number }>;
export type TeacherOpenTaskView = Readonly<{ task: FileSubmissionTask; completion: Readonly<{ eligibleStudentCount: number; submittedStudentCount: number }> }>;
export type TeacherClosedTaskView = Readonly<{ task: FileSubmissionTask; submissions: readonly Readonly<{ studentId: StudentId; displayName: string; studentNumber: string; displayFilename: string; declaredMimeType: string | null; byteLength: number; sha256: string; receivedCompleteAtUtc: IsoUtc }>[] }>;
export type StudentTaskView = Readonly<{ task: Readonly<Omit<FileSubmissionTask, 'maxBytes'>> & { maxBytes: typeof FILE_TASK_MAX_BYTES }; submission: SubmissionStatus }>;

export interface FileTaskRepository {
  createTask(task: FileSubmissionTask): FileSubmissionTask;
  task(taskId: FileSubmissionTaskId): FileSubmissionTask | undefined;
  updateDraft(taskId: FileSubmissionTaskId, input: Pick<FileSubmissionTask, 'title' | 'description' | 'deadlineAtUtc'>): FileSubmissionTask | undefined;
  openTask(taskId: FileSubmissionTaskId, openedAtUtc: IsoUtc): FileSubmissionTask | undefined;
  closeTask(taskId: FileSubmissionTaskId, closedAtUtc: IsoUtc): FileSubmissionTask | undefined;
  completion(taskId: FileSubmissionTaskId): TeacherOpenTaskView['completion'];
  studentSubmission(taskId: FileSubmissionTaskId, studentId: StudentId): FileSubmission | undefined;
  closedSubmissions(taskId: FileSubmissionTaskId): TeacherClosedTaskView['submissions'];
  createSubmission(input: NewFileSubmission): FileSubmission;
  /** Marks metadata only; service coordinates this with a reversible storage operation. */
  markSubmissionDeleted(taskId: FileSubmissionTaskId, studentId: StudentId, deletedAtUtc: IsoUtc): FileSubmission | undefined;
  restoreSubmission(submissionId: FileSubmissionId): void;
  /** A task may be removed only after all physical submissions have been individually removed. */
  deleteEmptyTask(taskId: FileSubmissionTaskId): boolean;
}

/**
 * The bytes pipeline owns how a staging file is validated, hashed, and renamed.
 * This port is intentionally only the reversible deletion seam shared with it.
 * stageDeletion must make no permanent deletion until commit; rollback must make
 * the original files readable again even when commit reported an error.
 */
export interface FileStoragePort {
  stageDeletion(entries: readonly Readonly<{ storageKey: string; submissionId: FileSubmissionId }>[]): FileStorageDeletion;
}
export interface FileStorageDeletion { commit(): void; rollback(): void; }

export interface FileTeacherAuthorization { assertAuthorized(context: unknown): void; }
export interface FileStudentAuthorization { assertAuthorized(context: unknown): AuthorizedStudentContext; }

export type FileTaskRouteDependencies = Readonly<{
  service: FileTaskServicePort;
  /** The route verifies path class/task agreement before it dispatches a command. */
  repository: Pick<FileTaskRepository, 'task'>;
  teacherContext: (request: IncomingMessage) => unknown;
  studentContext: (request: IncomingMessage) => unknown;
}>;
export interface FileTaskServicePort {
  createDraft(teacherContext: unknown, classId: ClassId, input: FileTaskDraftInput): FileSubmissionTask;
  updateDraft(teacherContext: unknown, taskId: FileSubmissionTaskId, input: FileTaskDraftInput): FileSubmissionTask;
  open(teacherContext: unknown, taskId: FileSubmissionTaskId): FileSubmissionTask;
  close(teacherContext: unknown, taskId: FileSubmissionTaskId): FileSubmissionTask;
  readForTeacher(teacherContext: unknown, taskId: FileSubmissionTaskId): TeacherOpenTaskView | TeacherClosedTaskView;
  readForStudent(studentContext: unknown, taskId: FileSubmissionTaskId): StudentTaskView;
  /** Bytes pipeline calls this before accepting a body and again via commitSubmission after hashing. */
  prepareSubmission(studentContext: unknown, taskId: FileSubmissionTaskId): FileSubmissionTask;
  commitSubmission(studentContext: unknown, input: Omit<NewFileSubmission, 'studentId'>): FileSubmission;
  deleteSubmission(teacherContext: unknown, taskId: FileSubmissionTaskId, studentId: StudentId, confirmation: DeleteConfirmation): void;
  deleteTask(teacherContext: unknown, taskId: FileSubmissionTaskId, confirmation: DeleteConfirmation): void;
}
