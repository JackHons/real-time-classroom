import { randomUUID, createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import type { UploadSessionId } from '../domain/types.js';
import { UploadStorage } from './storage.js';
import { MAX_UPLOAD_BYTES, type ReconciliationRecord, type StoredUpload, type UploadInput, UploadPipelineError, type UploadPipelineRepository } from './types.js';

export type UploadPipelineOptions = Readonly<{
  repository: UploadPipelineRepository;
  storage: UploadStorage;
  /** Test deployments may lower this, but production may never raise the product cap. */
  maxBytes?: number;
  maxActiveStreams?: number;
  now?: () => Date;
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
    let begun = false; let handle: FileHandle | undefined; let committedIntent = false; let renamed = false;
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
      if (Date.parse(receivedCompleteAtUtc) > deadlineAtMs) throw new UploadPipelineError('UPLOAD_DEADLINE_EXPIRED');
      this.options.repository.recordVerified({ uploadSessionId, bytesReceived: byteLength, sha256, receivedCompleteAtUtc });
      const storageKey = randomUUID();
      this.options.repository.prepareFileCommit({ uploadSessionId, finalStorageKey: storageKey });
      committedIntent = true;
      await this.options.storage.renameStagingToFinal(stagingKey, storageKey);
      renamed = true;
      try { this.options.repository.commitAfterFileRename({ uploadSessionId, finalStorageKey: storageKey }); }
      catch (error) {
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
      if (committedIntent && renamed) this.markRecovery(uploadSessionId, error);
      if (error instanceof UploadPipelineError) throw error;
      throw new UploadPipelineError(codeFor(error), error);
    } finally { release(); }
  }

  /** Call once at startup, before accepting new uploads. */
  async reconcile(): Promise<Readonly<{ recovered: number; cleaned: number; metadataMissing: number }>> {
    let recovered = 0; let cleaned = 0; let metadataMissing = 0;
    for (const record of this.options.repository.listForReconciliation()) {
      if (record.state === 'staging' || record.state === 'validating') {
        await this.options.storage.removeStaging(record.stagingKey).catch(() => undefined);
        this.markFailed(record.uploadSessionId, 'RESTART_STAGING_CLEANED'); cleaned += 1; continue;
      }
      if (record.state === 'metadata_committed') {
        if (record.stagingKey !== null) await this.options.storage.removeStaging(record.stagingKey).catch(() => undefined);
        if (record.finalStorageKey === null || !await this.options.storage.existsFinal(record.finalStorageKey)) metadataMissing += 1;
        continue;
      }
      if (await this.recoverCommittedIntent(record)) recovered += 1;
      else cleaned += 1;
    }
    return { recovered, cleaned, metadataMissing };
  }

  private async recoverCommittedIntent(record: ReconciliationRecord): Promise<boolean> {
    if (record.finalStorageKey === null || record.sha256 === null || record.stagingKey === null) { this.markFailed(record.uploadSessionId, 'RECOVERY_METADATA_INVALID'); return false; }
    try {
      if (!await this.options.storage.existsFinal(record.finalStorageKey)) {
        if (!await this.options.storage.existsStaging(record.stagingKey) || !await this.options.storage.verifyStaging(record.stagingKey, record.bytesReceived, record.sha256)) {
          await this.options.storage.removeStaging(record.stagingKey).catch(() => undefined);
          this.markFailed(record.uploadSessionId, 'RECOVERY_STAGED_FILE_INVALID'); return false;
        }
        await this.options.storage.renameStagingToFinal(record.stagingKey, record.finalStorageKey);
      }
      this.options.repository.commitAfterFileRename({ uploadSessionId: record.uploadSessionId, finalStorageKey: record.finalStorageKey });
      return true;
    } catch (error) { this.markRecovery(record.uploadSessionId, error); return false; }
  }

  private markFailed(id: UploadSessionId, code: string): void { try { this.options.repository.markFailed(id, code); } catch { /* preserve the original failure */ } }
  private markRecovery(id: UploadSessionId, error: unknown): void { try { this.options.repository.markRecoveryPending(id, codeFor(error)); } catch { /* startup reconciliation will retry the durable intent */ } }
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
