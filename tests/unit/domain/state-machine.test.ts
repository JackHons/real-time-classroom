import { describe, expect, it } from 'vitest';
import { assertLifecycleTransition, canTransitionUpload } from '../../../apps/server/src/domain/state-machine.js';

describe('state machines', () => {
  it('allows only forward question lifecycle transitions', () => {
    expect(() => assertLifecycleTransition('draft', 'open')).not.toThrow();
    expect(() => assertLifecycleTransition('open', 'closed')).not.toThrow();
    expect(() => assertLifecycleTransition('closed', 'open')).toThrow('Invalid lifecycle transition');
  });

  it('keeps upload recovery explicit', () => {
    expect(canTransitionUpload('file_committed', 'recovery_pending')).toBe(true);
    expect(canTransitionUpload('metadata_committed', 'failed')).toBe(false);
    expect(canTransitionUpload('staging', 'metadata_committed')).toBe(false);
  });
});
