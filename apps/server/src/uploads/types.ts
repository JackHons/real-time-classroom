import type { ClassId, FileSubmissionTaskId, StudentId, UploadSessionId, UploadState } from '../domain/types.js';

/** The product-level hard limit. Tests may configure a lower limit only. */
export const MAX_UPLOAD_BYTES = 100_000_000;

export type UploadStart = Readonly<{
  uploadSessionId: UploadSessionId;
  taskId: FileSubmissionTaskId;
  studentId: StudentId;
  stagingKey: string;
  originalFilename: string;
  displayFilename: string;
  declaredMimeType: string | null;
}>;

export type UploadTaskPolicy = Readonly<{ deadlineAtUtc: string; maxBytes: number }>;
/** Result of the atomic metadata admission after the file rename. */
export type UploadCommitOutcome = Readonly<{ accepted: boolean; closedTask?: Readonly<{ taskId: FileSubmissionTaskId; classId: ClassId }> }>;

export type ReconciliationRecord = Readonly<{
  uploadSessionId: UploadSessionId;
  state: UploadState;
  stagingKey: string | null;
  finalStorageKey: string | null;
  bytesReceived: number;
  sha256: string | null;
}>;

/**
 * Persistence boundary for byte ingestion. Authentication and task-route
 * ownership stay outside this port; this adapter still verifies membership and
 * task state so a caller cannot manufacture a cross-class upload.
 */
export interface UploadPipelineRepository {
  begin(input: UploadStart): UploadTaskPolicy;
  recordVerified(input: Readonly<{ uploadSessionId: UploadSessionId; bytesReceived: number; sha256: string; receivedCompleteAtUtc: string }>): void;
  prepareFileCommit(input: Readonly<{ uploadSessionId: UploadSessionId; finalStorageKey: string }>): void;
  commitAfterFileRename(input: Readonly<{ uploadSessionId: UploadSessionId; finalStorageKey: string }>): void | UploadCommitOutcome;
  /** Clears the durable rename intent only after its rejected final object is gone. */
  completeRejectedFileCommit?(input: Readonly<{ uploadSessionId: UploadSessionId; finalStorageKey: string }>): void;
  markRecoveryPending(uploadSessionId: UploadSessionId, errorCode: string): void;
  markFailed(uploadSessionId: UploadSessionId, errorCode: string): void;
  /** Retains the durable staging key when physical cleanup has not happened. */
  markStagingCleanupFailed(uploadSessionId: UploadSessionId, errorCode: string): void;
  /** Clears a staging key only after its private object was removed, with a payload-free audit record. */
  completeStagingCleanup(uploadSessionId: UploadSessionId, cleanupCode: string): void;
  /** A committed metadata row without its opaque final object is not a success. */
  markIntegrityFailure(uploadSessionId: UploadSessionId, errorCode: string): void;
  listForReconciliation(): readonly ReconciliationRecord[];
}

export type UploadInput = Readonly<{
  taskId: FileSubmissionTaskId;
  studentId: StudentId;
  bytes: AsyncIterable<Uint8Array>;
  originalFilename?: string;
  declaredMimeType?: string | null;
  expectedBytes?: number;
  expectedSha256?: string;
  /** Structural on purpose: HTTP adapters can pass request-abort state without a DOM global. */
  signal?: Readonly<{ aborted: boolean }>;
}>;

export type StoredUpload = Readonly<{
  uploadSessionId: UploadSessionId;
  storageKey: string;
  byteLength: number;
  sha256: string;
  receivedCompleteAtUtc: string;
}>;

export class UploadPipelineError extends Error {
  constructor(readonly code: string, cause?: unknown) { super(code, { cause }); this.name = 'UploadPipelineError'; }
}
