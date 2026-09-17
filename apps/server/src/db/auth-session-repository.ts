import type { SqliteDatabase } from './connection.js';
import type { ClassId, IsoUtc, StudentId, StudentSession, StudentSessionId, TeacherSession, TeacherSessionId } from '../domain/types.js';

export type StoredStudentSession = StudentSession;
export type StoredTeacherSession = TeacherSession;

export interface AuthSessionRepository {
  teacherPasswordHash(): string | undefined;
  /** Atomically claims the one shared-teacher credential slot. */
  setTeacherPasswordHashIfAbsent(hash: string, now: IsoUtc): boolean;
  createTeacherSession(input: StoredTeacherSession): void;
  createStudentSession(input: StoredStudentSession): void;
  findTeacherSession(tokenHash: string): StoredTeacherSession | undefined;
  findStudentSession(tokenHash: string): StoredStudentSession | undefined;
  touchTeacherSession(tokenHash: string, now: IsoUtc, idleExpiresAtUtc: IsoUtc): StoredTeacherSession | undefined;
  touchStudentSession(tokenHash: string, now: IsoUtc, idleExpiresAtUtc: IsoUtc): StoredStudentSession | undefined;
  revokeTeacherSession(tokenHash: string, revokedAtUtc: IsoUtc): boolean;
  revokeStudentSession(tokenHash: string, revokedAtUtc: IsoUtc): boolean;
  revokeTeacherSessionById(id: TeacherSessionId, revokedAtUtc: IsoUtc): boolean;
  revokeStudentSessionById(id: StudentSessionId, revokedAtUtc: IsoUtc): boolean;
  /** Atomically records a student leaving their current class and revokes only this session. */
  leaveStudentSession(tokenHash: string, revokedAtUtc: IsoUtc): StoredStudentSession | undefined;
}

type TeacherRow = {
  id: string; token_hash: string; created_at_utc: string; last_seen_at_utc: string;
  absolute_expires_at_utc: string; idle_expires_at_utc: string; revoked_at_utc: string | null;
};
type StudentRow = TeacherRow & { student_id: string; class_id: string };

/** Auth-specific persistence boundary. It intentionally does not reuse the trusted internal DomainRepository. */
export class SqliteAuthSessionRepository implements AuthSessionRepository {
  constructor(private readonly database: SqliteDatabase) {}

  teacherPasswordHash(): string | undefined {
    return (this.database.prepare("SELECT value FROM app_settings WHERE key='teacher_shared_password_hash'").get() as { value: string } | undefined)?.value;
  }

  setTeacherPasswordHashIfAbsent(hash: string, now: IsoUtc): boolean {
    const result = this.database.prepare("INSERT INTO app_settings (key,value,created_at_utc,updated_at_utc) VALUES ('teacher_shared_password_hash',?,?,?) ON CONFLICT(key) DO NOTHING").run(hash, now, now);
    return result.changes === 1;
  }

  createTeacherSession(input: StoredTeacherSession): void {
    this.database.prepare('INSERT INTO teacher_sessions (id,token_hash,created_at_utc,last_seen_at_utc,absolute_expires_at_utc,idle_expires_at_utc,revoked_at_utc) VALUES (?,?,?,?,?,?,?)').run(input.id, input.tokenHash, input.createdAtUtc, input.lastSeenAtUtc, input.absoluteExpiresAtUtc, input.idleExpiresAtUtc, input.revokedAtUtc);
  }

  createStudentSession(input: StoredStudentSession): void {
    this.database.transaction(() => {
      this.database.prepare('UPDATE student_sessions SET revoked_at_utc=? WHERE student_id=? AND revoked_at_utc IS NULL AND (absolute_expires_at_utc <= ? OR idle_expires_at_utc <= ?)').run(input.createdAtUtc, input.studentId, input.createdAtUtc, input.createdAtUtc);
      const active = this.database.prepare('SELECT id FROM student_sessions WHERE student_id=? AND revoked_at_utc IS NULL').get(input.studentId);
      if (active !== undefined) throw new Error('STUDENT_SESSION_ALREADY_ACTIVE');
      this.database.prepare('INSERT INTO student_sessions (id,student_id,class_id,token_hash,created_at_utc,last_seen_at_utc,absolute_expires_at_utc,idle_expires_at_utc,revoked_at_utc) VALUES (?,?,?,?,?,?,?,?,?)').run(input.id, input.studentId, input.classId, input.tokenHash, input.createdAtUtc, input.lastSeenAtUtc, input.absoluteExpiresAtUtc, input.idleExpiresAtUtc, input.revokedAtUtc);
    })();
  }

  findTeacherSession(tokenHash: string): StoredTeacherSession | undefined {
    const row = this.database.prepare('SELECT id,token_hash,created_at_utc,last_seen_at_utc,absolute_expires_at_utc,idle_expires_at_utc,revoked_at_utc FROM teacher_sessions WHERE token_hash=?').get(tokenHash) as TeacherRow | undefined;
    return row === undefined ? undefined : toTeacherSession(row);
  }

  findStudentSession(tokenHash: string): StoredStudentSession | undefined {
    const row = this.database.prepare('SELECT id,student_id,class_id,token_hash,created_at_utc,last_seen_at_utc,absolute_expires_at_utc,idle_expires_at_utc,revoked_at_utc FROM student_sessions WHERE token_hash=?').get(tokenHash) as StudentRow | undefined;
    return row === undefined ? undefined : toStudentSession(row);
  }

  touchTeacherSession(tokenHash: string, now: IsoUtc, idleExpiresAtUtc: IsoUtc): StoredTeacherSession | undefined {
    return this.touch('teacher_sessions', tokenHash, now, idleExpiresAtUtc, () => this.findTeacherSession(tokenHash));
  }

  touchStudentSession(tokenHash: string, now: IsoUtc, idleExpiresAtUtc: IsoUtc): StoredStudentSession | undefined {
    return this.touch('student_sessions', tokenHash, now, idleExpiresAtUtc, () => this.findStudentSession(tokenHash));
  }

  revokeTeacherSession(tokenHash: string, revokedAtUtc: IsoUtc): boolean { return this.revoke('teacher_sessions', 'token_hash', tokenHash, revokedAtUtc); }
  revokeStudentSession(tokenHash: string, revokedAtUtc: IsoUtc): boolean { return this.revoke('student_sessions', 'token_hash', tokenHash, revokedAtUtc); }
  revokeTeacherSessionById(id: TeacherSessionId, revokedAtUtc: IsoUtc): boolean { return this.revoke('teacher_sessions', 'id', id, revokedAtUtc); }
  revokeStudentSessionById(id: StudentSessionId, revokedAtUtc: IsoUtc): boolean { return this.revoke('student_sessions', 'id', id, revokedAtUtc); }
  leaveStudentSession(tokenHash: string, revokedAtUtc: IsoUtc): StoredStudentSession | undefined {
    return this.database.transaction(() => {
      const session = this.findStudentSession(tokenHash);
      if (session === undefined || session.revokedAtUtc !== null || session.absoluteExpiresAtUtc <= revokedAtUtc || session.idleExpiresAtUtc <= revokedAtUtc) return undefined;
      const revoked = this.database.prepare('UPDATE student_sessions SET revoked_at_utc=? WHERE token_hash=? AND revoked_at_utc IS NULL').run(revokedAtUtc, tokenHash);
      if (revoked.changes !== 1) return undefined;
      // Leave history is preserved for the teacher dashboard. Student rows,
      // answers, submissions and materials are never touched here.
      this.database.prepare('UPDATE student_class_joins SET left_at_utc=? WHERE student_id=? AND class_id=? AND left_at_utc IS NULL').run(revokedAtUtc, session.studentId, session.classId);
      return session;
    })();
  }

  private touch<T>(table: 'teacher_sessions' | 'student_sessions', tokenHash: string, now: IsoUtc, idleExpiresAtUtc: IsoUtc, find: () => T | undefined): T | undefined {
    const result = this.database.prepare(`UPDATE ${table} SET last_seen_at_utc=?,idle_expires_at_utc=? WHERE token_hash=? AND revoked_at_utc IS NULL AND absolute_expires_at_utc>? AND idle_expires_at_utc>?`).run(now, idleExpiresAtUtc, tokenHash, now, now);
    return result.changes === 1 ? find() : undefined;
  }

  private revoke(table: 'teacher_sessions' | 'student_sessions', field: 'id' | 'token_hash', value: string, revokedAtUtc: IsoUtc): boolean {
    const result = this.database.prepare(`UPDATE ${table} SET revoked_at_utc=? WHERE ${field}=? AND revoked_at_utc IS NULL`).run(revokedAtUtc, value);
    return result.changes === 1;
  }
}

function toTeacherSession(row: TeacherRow): StoredTeacherSession {
  return { id: row.id as TeacherSessionId, tokenHash: row.token_hash, createdAtUtc: row.created_at_utc as IsoUtc, lastSeenAtUtc: row.last_seen_at_utc as IsoUtc, absoluteExpiresAtUtc: row.absolute_expires_at_utc as IsoUtc, idleExpiresAtUtc: row.idle_expires_at_utc as IsoUtc, revokedAtUtc: row.revoked_at_utc as IsoUtc | null };
}

function toStudentSession(row: StudentRow): StoredStudentSession {
  return { ...toTeacherSession(row), id: row.id as StudentSessionId, studentId: row.student_id as StudentId, classId: row.class_id as ClassId };
}
