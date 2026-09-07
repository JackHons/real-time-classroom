import type { LifecycleState, UploadState } from './types.js';

export function canTransitionLifecycle(from: LifecycleState, to: LifecycleState): boolean {
  return (from === 'draft' && to === 'open') || (from === 'open' && to === 'closed');
}

export function assertLifecycleTransition(from: LifecycleState, to: LifecycleState): void {
  if (!canTransitionLifecycle(from, to)) throw new Error(`Invalid lifecycle transition: ${from} -> ${to}`);
}

export function canTransitionUpload(from: UploadState, to: UploadState): boolean {
  if (to === 'failed') return from !== 'metadata_committed' && from !== 'failed';
  return (from === 'queued' && to === 'staging') || (from === 'staging' && to === 'validating') || (from === 'validating' && to === 'file_committed') || (from === 'file_committed' && (to === 'metadata_committed' || to === 'recovery_pending'));
}
