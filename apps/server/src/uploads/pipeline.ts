import { randomUUID, createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import type { ClassId, UploadSessionId } from '../domain/types.js';
import { UploadStorage } from './storage.js';
import { MAX_UPLOAD_BYTES, type ReconciliationRecord, type StoredUpload, type UploadInput, UploadPipelineError, type UploadPipelineRepository } from './types.js';

export type UploadPipelineOptions = Readonly<{
  repository: UploadPipelineRepository;
  storage: UploadStorage;
  /** Test deployments may lower this, but production may never raise the product cap. */
  maxBytes?: number;
  maxActiveStreams?: number;
  now?: () => Date;
  /** The repository reports the single atomic deadline-close winner. */
  onTaskClosed?: (task: Readonly<{ taskId: string; classId: ClassId }>) => void;
}>;

/** In-process reservation. The database adapter covers the restart/cross-worker case. */
export class UploadReservationGate {
  private readonly activeKeys = new Set<string>();
  private active = 0;
  constructor(private readonly maximum = 10) { if (!Number.isInteger(maximum) || maximum < 1) throw new Error('INVALID_ACTIVE_UPLOAD_LIMIT'); }
  reserve(taskId: string, studentId: string): () => void {
    const key = `${taskId}\u0000${studentId}`;
    if (this.active >= this.maximum) throw new UploadPipelineError('UPLOAD_STREAM_LIMIT_REACHED');
    if (this.activeKeys.has(key)) throw new UploadPipelineError('UPLOAD_ALREADY_ACTIVE_FOR_STUDENT_TASK');
    this.active += 1; this.activeKeys.add(key);
    let released = false;
    return () => { if (!released) { released = true; this.active -= 1; this.activeKeys.delete(key); } };
  }
}

export class UploadPipeline {
  private readonly maximumBytes: number;
  private readonly now: () => Date;
  private readonly reservations: UploadReservationGate;

  constructor(private readonly options: UploadPipelineOptions) {
    this.maximumBytes = options.maxBytes ?? MAX_UPLOAD_BYTES;
    if (!Number.isSafeInteger(this.maximumBytes) || this.maximumBytes < 1 || this.maximumBytes > MAX_UPLOAD_BYTES) throw new Error('INVALID_UPLOAD_BYTE_LIMIT');
    this.now = options.now ?? (() => new Date());
    this.reservations = new UploadReservationGate(options.maxActiveStreams ?? 10);
  }

  async ingest(input: UploadInput): Promise<StoredUpload> {
    const release = this.reservations.reserve(input.taskId, input.studentId);
    const uploadSessionId = randomUUID() as UploadSessionId;
    const stagingKey = this.options.storage.stagingKey(uploadSessionId);
    const originalFilename = sanitizeFilename(input.originalFilename ?? 'upload.bin');
    const displayFilename = originalFilename;
    let begun = false; let handle: FileHandle | undefined; let committedIntent = false; let renamed = false; let rejectedAtCommit = false;
    try {
      const policy = this.options.repository.begin({ uploadSessionId, taskId: input.taskId, studentId: input.studentId, stagingKey, originalFilename, displayFilename, declaredMimeType: input.declaredMimeType ?? null });
      begun = true;
      const limit = Math.min(this.maximumBytes, policy.maxBytes, MAX_UPLOAD_BYTES);
      handle = await this.options.storage.openExclusiveStaging(stagingKey);
      const { byteLength, sha256 } = await writeAndHash(handle, input.bytes, limit, input.signal);
      await handle.sync(); await handle.close(); handle = undefined;
      if (input.expectedBytes !== undefined && input.expectedBytes !== byteLength) throw new UploadPipelineError('UPLOAD_TRUNCATED');
      if (input.expectedSha256 !== undefined && (!/^[a-f0-9]{64}$/.test(input.expectedSha256) || input.expectedSha256 !== sha256)) throw new UploadPipelineError('UPLOAD_HASH_MISMATCH');
      const receivedCompleteAtUtc = this.now().toISOString();
      const deadlineAtMs = Date.parse(policy.deadlineAtUtc);
      if (!Number.isFinite(deadlineAtMs)) throw new UploadPipelineError('UPLOAD_DEADLINE_INVALID');
      // The SQLite metadata commit below is the authoritative deadline check:
      // it atomically closes the task and rejects all concurrent late writers.
      this.options.repository.recordVerified({ uploadSessionId, bytesReceived: byteLength, sha256, receivedCompleteAtUtc });
      const storageKey = randomUUID();
      this.options.repository.prepareFileCommit({ uploadSessionId, finalStorageKey: storageKey });
      committedIntent = true;
      await this.options.storage.renameStagingToFinal(stagingKey, storageKey);
      renamed = true;
      try {
        const outcome = this.options.repository.commitAfterFileRename({ uploadSessionId, finalStorageKey: storageKey });
        if (outcome !== undefined && outcome.accepted === false) {
          await this.options.storage.removeFinal(storageKey);
          this.completeRejectedCommit(uploadSessionId, storageKey);
          rejectedAtCommit = true;
          if (outcome.closedTask !== undefined) { try { this.options.onTaskClosed?.(outcome.closedTask); } catch { /* durable close wins */ } }
          throw new UploadPipelineError('FILE_TASK_CLOSED');
        }
      }
      catch (error) {
        if (error instanceof UploadPipelineError) throw error;
        this.markRecovery(uploadSessionId, error);
        throw new UploadPipelineError('UPLOAD_METADATA_RECOVERY_PENDING', error);
      }
      return { uploadSessionId, storageKey, byteLength, sha256, receivedCompleteAtUtc };
    } catch (error) {
      if (handle !== undefined) await handle.close().catch(() => undefined);
      if (!renamed) await this.options.storage.removeStaging(stagingKey).catch(() => undefined);
      if (begun && !renamed) this.markFailed(uploadSessionId, codeFor(error));
      // A renamed final must survive: reconciliation uses its durable intent to
      // finish the DB transaction. It must never be silently deleted here.
      if (committedIntent && renamed && !rejectedAtCommit) this.markRecovery(uploadSessionId, error);
      if (error instanceof UploadPipelineError) throw error;
      throw new UploadPipelineError(codeFor(error), error);
    } finally { release(); }
  }

  /** Call once at startup, before accepting new uploads. */
  async reconcile(): Promise<Readonly<{ recovered: number; cleaned: number; metadataMissing: number; cleanupFailed: number }>> {
    let recovered = 0; let cleaned = 0; let metadataMissing = 0; let cleanupFailed = 0;
    for (const record of this.options.repository.listForReconciliation()) {
      if (record.state === 'staging' || record.state === 'validating' || record.state === 'failed') {
        if (record.stagingKey === null) { this.markFailed(record.uploadSessionId, 'RESTART_STAGING_CLEANED'); cleaned += 1; continue; }
        if (await this.cleanupStaging(record)) cleaned += 1;
        else cleanupFailed += 1;
        continue;
      }
      if (record.state === 'metadata_committed') {
        if (record.stagingKey !== null) {
          if (await this.cleanupStaging(record)) cleaned += 1;
          else { cleanupFailed += 1; continue; }
        }
        if (record.finalStorageKey === null || !await this.options.storage.existsFinal(record.finalStorageKey)) {
          // Do not leave a missing final looking like a successful submission:
          // retire the live metadata, record a payload-free integrity marker,
          // and permit the student to submit again under the normal policy.
          this.markIntegrityFailure(record.uploadSessionId, 'METADATA_FINAL_FILE_MISSING'); metadataMissing += 1;
        }
        continue;
      }
      const outcome = await this.recoverCommittedIntent(record);
      if (outcome === 'recovered') recovered += 1;
      else if (outcome === 'cleaned') cleaned += 1;
      else cleanupFailed += 1;
    }
    return { recovered, cleaned, metadataMissing, cleanupFailed };
  }

  private async cleanupStaging(record: ReconciliationRecord): Promise<boolean> {
    try {
      await this.options.storage.removeStaging(record.stagingKey);
      this.options.repository.completeStagingCleanup(record.uploadSessionId, 'RESTART_STAGING_CLEANED');
      return true;
    } catch {
      this.markStagingCleanupFailed(record.uploadSessionId, 'RESTART_STAGING_CLEANUP_FAILED');
      return false;
    }
  }

  private async recoverCommittedIntent(record: ReconciliationRecord): Promise<'recovered' | 'cleaned' | 'failed'> {
    if (record.finalStorageKey === null || record.sha256 === null || record.stagingKey === null) { this.markFailed(record.uploadSessionId, 'RECOVERY_METADATA_INVALID'); return 'cleaned'; }
    try {
      if (!await this.options.storage.existsFinal(record.finalStorageKey)) {
        if (!await this.options.storage.existsStaging(record.stagingKey) || !await this.options.storage.verifyStaging(record.stagingKey, record.bytesReceived, record.sha256)) {
          await this.options.storage.removeStaging(record.stagingKey).catch(() => undefined);
          this.markFailed(record.uploadSessionId, 'RECOVERY_STAGED_FILE_INVALID'); return 'cleaned';
        }
        await this.options.storage.renameStagingToFinal(record.stagingKey, record.finalStorageKey);
      }
      const outcome = this.options.repository.commitAfterFileRename({ uploadSessionId: record.uploadSessionId, finalStorageKey: record.finalStorageKey });
      if (outcome !== undefined && outcome.accepted === false) {
        await this.options.storage.removeFinal(record.finalStorageKey);
        this.completeRejectedCommit(record.uploadSessionId, record.finalStorageKey);
        if (outcome.closedTask !== undefined) { try { this.options.onTaskClosed?.(outcome.closedTask); } catch { /* durable close wins */ } }
        return 'cleaned';
      }
      return 'recovered';
    } catch (error) { this.markRecovery(record.uploadSessionId, error); return 'failed'; }
  }

  private completeRejectedCommit(uploadSessionId: UploadSessionId, finalStorageKey: string): void {
    if (this.options.repository.completeRejectedFileCommit !== undefined) this.options.repository.completeRejectedFileCommit({ uploadSessionId, finalStorageKey });
    else this.markFailed(uploadSessionId, 'FILE_TASK_CLOSED');
  }

  private markFailed(id: UploadSessionId, code: string): void { try { this.options.repository.markFailed(id, code); } catch { /* preserve the original failure */ } }
  private markStagingCleanupFailed(id: UploadSessionId, code: string): void { try { this.options.repository.markStagingCleanupFailed(id, code); } catch { /* preserve the original failure */ } }
  private markRecovery(id: UploadSessionId, error: unknown): void { try { this.options.repository.markRecoveryPending(id, codeFor(error)); } catch { /* startup reconciliation will retry the durable intent */ } }
  private markIntegrityFailure(id: UploadSessionId, code: string): void { try { this.options.repository.markIntegrityFailure(id, code); } catch { /* a later startup must retry the visible inconsistency */ } }
}

async function writeAndHash(handle: FileHandle, chunks: AsyncIterable<Uint8Array>, maximum: number, signal: Readonly<{ aborted: boolean }> | undefined): Promise<Readonly<{ byteLength: number; sha256: string }>> {
  const hash = createHash('sha256'); let byteLength = 0;
  for await (const chunk of chunks) {
    if (signal?.aborted) throw new UploadPipelineError('UPLOAD_ABORTED');
    if (!(chunk instanceof Uint8Array)) throw new UploadPipelineError('UPLOAD_INVALID_CHUNK');
    if (chunk.byteLength > maximum - byteLength) throw new UploadPipelineError('UPLOAD_TOO_LARGE');
    await writeFully(handle, chunk); byteLength += chunk.byteLength; hash.update(chunk);
  }
  if (signal?.aborted) throw new UploadPipelineError('UPLOAD_ABORTED');
  return { byteLength, sha256: hash.digest('hex') };
}

async function writeFully(handle: FileHandle, source: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < source.byteLength) {
    const result = await handle.write(source, offset, source.byteLength - offset);
    if (result.bytesWritten <= 0) throw new Error('UPLOAD_ZERO_BYTE_WRITE');
    offset += result.bytesWritten;
  }
}

function sanitizeFilename(value: string): string {
  const leaf = value.replace(/\\/g, '/').split('/').pop() ?? '';
  const cleaned = Array.from(leaf).filter((character) => character.charCodeAt(0) >= 32 && !'<>:"|?*'.includes(character)).join('').trim().slice(0, 255);
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'upload.bin' : cleaned;
}

function codeFor(error: unknown): string {
  if (error instanceof UploadPipelineError) return error.code;
  if (error instanceof Error && /^FILE_(?:TASK|UPLOAD|SUBMISSION)_/.test(error.message)) return error.message;
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'ENOSPC') return 'UPLOAD_STORAGE_FULL';
    if (code === 'ABORT_ERR') return 'UPLOAD_ABORTED';
  }
  return 'UPLOAD_STORAGE_WRITE_FAILED';
}
