import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createSessionTimes, isSessionActive, SESSION_IDLE_MS, utc } from '../domain/normalization.js';
import type { Student, StudentSession, TeacherSession } from '../domain/types.js';
import type { AuthSessionRepository } from '../db/auth-session-repository.js';

export const TEACHER_SESSION_COOKIE = 'teacher_session';
export const STUDENT_SESSION_COOKIE = 'student_session';

export type SessionToken = string & Readonly<{ readonly __brand: 'SessionToken' }>;
export type TeacherLoginResult = Readonly<{ token: SessionToken; session: TeacherSession }>;
export type StudentLoginResult = Readonly<{ token: SessionToken; session: StudentSession }>;
export type AuthenticatedTeacherSession = Readonly<{ teacherSessionId: TeacherSession['id'] }>;
export type AuthenticatedStudentSession = Readonly<{ studentSessionId: StudentSession['id']; studentId: StudentSession['studentId']; classId: StudentSession['classId'] }>;

export interface Clock { now(): Date; }
export const systemClock: Clock = { now: () => new Date() };

export class AuthSessions {
  constructor(private readonly repository: AuthSessionRepository, private readonly clock: Clock = systemClock, private readonly newToken: () => SessionToken = secureSessionToken) {}

  createTeacherSession(): TeacherLoginResult {
    const now = this.clock.now();
    const token = this.newToken();
    const session: TeacherSession = { id: randomUUID() as TeacherSession['id'], tokenHash: hashSessionToken(token), ...createSessionTimes(now) };
    this.repository.createTeacherSession(session);
    return { token, session };
  }

  createStudentSession(student: Student): StudentLoginResult {
    const now = this.clock.now();
    const token = this.newToken();
    const session: StudentSession = { id: randomUUID() as StudentSession['id'], studentId: student.id, classId: student.classId, tokenHash: hashSessionToken(token), ...createSessionTimes(now) };
    this.repository.createStudentSession(session);
    return { token, session };
  }

  authenticateTeacher(token: string | undefined): AuthenticatedTeacherSession | undefined {
    if (token === undefined) return undefined;
    const now = this.clock.now();
    const tokenHash = hashSessionToken(token);
    const session = this.repository.findTeacherSession(tokenHash);
    if (session === undefined || !isSessionActive(session, now)) return undefined;
    const touched = this.repository.touchTeacherSession(tokenHash, utc(now), nextIdleExpiry(session, now));
    return touched === undefined ? undefined : { teacherSessionId: touched.id };
  }

  authenticateStudent(token: string | undefined): AuthenticatedStudentSession | undefined {
    if (token === undefined) return undefined;
    const now = this.clock.now();
    const tokenHash = hashSessionToken(token);
    const session = this.repository.findStudentSession(tokenHash);
    if (session === undefined || !isSessionActive(session, now)) return undefined;
    const touched = this.repository.touchStudentSession(tokenHash, utc(now), nextIdleExpiry(session, now));
    return touched === undefined ? undefined : { studentSessionId: touched.id, studentId: touched.studentId, classId: touched.classId };
  }

  logoutTeacher(token: string | undefined): boolean { return token !== undefined && this.repository.revokeTeacherSession(hashSessionToken(token), utc(this.clock.now())); }
  logoutStudent(token: string | undefined): boolean { return token !== undefined && this.repository.revokeStudentSession(hashSessionToken(token), utc(this.clock.now())); }
  leaveStudentSession(token: string | undefined): AuthenticatedStudentSession | undefined {
    if (token === undefined) return undefined;
    const session = this.repository.leaveStudentSession(hashSessionToken(token), utc(this.clock.now()));
    return session === undefined ? undefined : { studentSessionId: session.id, studentId: session.studentId, classId: session.classId };
  }
  revokeTeacher(id: TeacherSession['id']): boolean { return this.repository.revokeTeacherSessionById(id, utc(this.clock.now())); }
  revokeStudent(id: StudentSession['id']): boolean { return this.repository.revokeStudentSessionById(id, utc(this.clock.now())); }
}

export function secureSessionToken(): SessionToken { return randomBytes(32).toString('base64url') as SessionToken; }
export function hashSessionToken(token: string): string { return createHash('sha256').update(token).digest('hex'); }

function nextIdleExpiry(session: TeacherSession | StudentSession, now: Date) {
  const candidate = new Date(now.getTime() + SESSION_IDLE_MS);
  const absolute = new Date(session.absoluteExpiresAtUtc);
  return utc(candidate < absolute ? candidate : absolute);
}
