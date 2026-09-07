import { describe, expect, it } from 'vitest';
import { createSessionTimes, isSessionActive, normalizeStudentNumber } from '../../../apps/server/src/domain/normalization.js';

describe('domain normalization and sessions', () => {
  it('normalizes NFKC, outer whitespace, and ASCII letters only', () => {
    expect(normalizeStudentNumber(' Ａb- １２  ')).toBe('AB- 12');
  });

  it('enforces independent absolute and idle expiry', () => {
    const start = new Date('2026-09-07T00:00:00.000Z');
    const session = createSessionTimes(start);
    expect(isSessionActive(session, new Date('2026-09-07T01:59:59.000Z'))).toBe(true);
    expect(isSessionActive(session, new Date('2026-09-07T02:00:00.000Z'))).toBe(false);
    expect(isSessionActive({ ...session, idleExpiresAtUtc: '2026-09-07T23:00:00.000Z' as typeof session.idleExpiresAtUtc }, new Date('2026-09-07T12:00:00.000Z'))).toBe(false);
  });
});
