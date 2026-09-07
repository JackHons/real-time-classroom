import { describe, expect, it } from 'vitest';
import type { AuthSessionRepository } from '../../../apps/server/src/db/auth-session-repository.js';
import type { IsoUtc, StudentSession, TeacherSession } from '../../../apps/server/src/domain/types.js';
import { AuthSessions, hashSessionToken, type Clock, type SessionToken } from '../../../apps/server/src/auth/session.js';

class MemoryRepository implements AuthSessionRepository {
  readonly teacher = new Map<string, TeacherSession>();
  readonly student = new Map<string, StudentSession>();
  teacherPasswordHash(): string | undefined { return undefined; }
  createTeacherSession(input: TeacherSession): void { this.teacher.set(input.tokenHash, input); }
  createStudentSession(input: StudentSession): void {
    if ([...this.student.values()].some((session) => session.studentId === input.studentId && session.revokedAtUtc === null)) throw new Error('STUDENT_SESSION_ALREADY_ACTIVE');
    this.student.set(input.tokenHash, input);
  }
  findTeacherSession(hash: string): TeacherSession | undefined { return this.teacher.get(hash); }
  findStudentSession(hash: string): StudentSession | undefined { return this.student.get(hash); }
  touchTeacherSession(hash: string, now: IsoUtc, idle: IsoUtc): TeacherSession | undefined { const session = this.teacher.get(hash); if (session === undefined || !active(session, now)) return undefined; const next = { ...session, lastSeenAtUtc: now, idleExpiresAtUtc: idle }; this.teacher.set(hash, next); return next; }
  touchStudentSession(hash: string, now: IsoUtc, idle: IsoUtc): StudentSession | undefined { const session = this.student.get(hash); if (session === undefined || !active(session, now)) return undefined; const next = { ...session, lastSeenAtUtc: now, idleExpiresAtUtc: idle }; this.student.set(hash, next); return next; }
  revokeTeacherSession(hash: string, now: IsoUtc): boolean { return this.revoke(this.teacher, hash, now); }
  revokeStudentSession(hash: string, now: IsoUtc): boolean { return this.revoke(this.student, hash, now); }
  revokeTeacherSessionById(id: TeacherSession['id'], now: IsoUtc): boolean { return this.revokeById(this.teacher, id, now); }
  revokeStudentSessionById(id: StudentSession['id'], now: IsoUtc): boolean { return this.revokeById(this.student, id, now); }
  private revoke<T extends TeacherSession | StudentSession>(map: Map<string, T>, hash: string, now: IsoUtc): boolean { const value = map.get(hash); if (value === undefined || value.revokedAtUtc !== null) return false; map.set(hash, { ...value, revokedAtUtc: now } as T); return true; }
  private revokeById<T extends TeacherSession | StudentSession>(map: Map<string, T>, id: string, now: IsoUtc): boolean { const item = [...map.entries()].find(([, value]) => value.id === id); return item === undefined ? false : this.revoke(map, item[0], now); }
}

class MutableClock implements Clock { constructor(private value: Date) {} now(): Date { return this.value; } set(value: string): void { this.value = new Date(value); } }
function active(session: TeacherSession | StudentSession, now: IsoUtc): boolean { return session.revokedAtUtc === null && session.absoluteExpiresAtUtc > now && session.idleExpiresAtUtc > now; }

describe('auth session service', () => {
  it('uses an opaque random token while persisting only its SHA-256 hash', () => {
    const repository = new MemoryRepository();
    const clock = new MutableClock(new Date('2026-09-07T00:00:00.000Z'));
    const sessions = new AuthSessions(repository, clock, () => 'private-browser-token' as SessionToken);
    const result = sessions.createTeacherSession();

    expect(result.token).toBe('private-browser-token');
    expect(repository.teacher.get(hashSessionToken(result.token))?.tokenHash).toBe(hashSessionToken(result.token));
    expect([...repository.teacher.values()][0]?.tokenHash).not.toContain(result.token);
  });

  it('touches idle expiry but never extends the 12-hour absolute expiry', () => {
    const repository = new MemoryRepository();
    const clock = new MutableClock(new Date('2026-09-07T00:00:00.000Z'));
    const sessions = new AuthSessions(repository, clock, () => 'token' as SessionToken);
    const created = sessions.createTeacherSession();
    const hash = hashSessionToken(created.token);
    const storedBefore = repository.teacher.get(hash);
    if (storedBefore === undefined) throw new Error('session was not created');
    // Simulate continuous activity having kept the idle window alive.
    repository.teacher.set(hash, { ...storedBefore, idleExpiresAtUtc: '2026-09-07T23:00:00.000Z' as IsoUtc });
    clock.set('2026-09-07T11:30:00.000Z');

    expect(sessions.authenticateTeacher(created.token)).toMatchObject({ teacherSessionId: created.session.id });
    const stored = repository.teacher.get(hash);
    expect(stored?.idleExpiresAtUtc).toBe('2026-09-07T12:00:00.000Z');
    expect(stored?.absoluteExpiresAtUtc).toBe('2026-09-07T12:00:00.000Z');
  });

  it('rejects expired or revoked tokens without touching them', () => {
    const repository = new MemoryRepository();
    const clock = new MutableClock(new Date('2026-09-07T00:00:00.000Z'));
    const sessions = new AuthSessions(repository, clock, () => 'token' as SessionToken);
    const created = sessions.createTeacherSession();
    clock.set('2026-09-07T12:00:00.000Z');
    expect(sessions.authenticateTeacher(created.token)).toBeUndefined();
    clock.set('2026-09-07T01:00:00.000Z');
    expect(sessions.logoutTeacher(created.token)).toBe(true);
    expect(sessions.authenticateTeacher(created.token)).toBeUndefined();
  });
});
