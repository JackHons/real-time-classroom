import type { IsoUtc, SessionTimes } from './types.js';

export const SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1000;
export const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;

export function normalizeStudentNumber(value: string): string {
  return value.normalize('NFKC').trim().replace(/[a-z]/g, (character) => character.toUpperCase());
}

export function utc(value: Date): IsoUtc {
  return value.toISOString() as IsoUtc;
}

export function createSessionTimes(now: Date): SessionTimes {
  return { createdAtUtc: utc(now), lastSeenAtUtc: utc(now), absoluteExpiresAtUtc: utc(new Date(now.getTime() + SESSION_ABSOLUTE_MS)), idleExpiresAtUtc: utc(new Date(now.getTime() + SESSION_IDLE_MS)), revokedAtUtc: null };
}

export function isSessionActive(session: SessionTimes, now: Date): boolean {
  const current = now.toISOString();
  return session.revokedAtUtc === null && current < session.absoluteExpiresAtUtc && current < session.idleExpiresAtUtc;
}
