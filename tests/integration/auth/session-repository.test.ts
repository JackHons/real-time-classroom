import { afterEach, describe, expect, it } from 'vitest';
import { SqliteAuthSessionRepository } from '../../../apps/server/src/db/auth-session-repository.js';
import { openSqlite, type SqliteDatabase } from '../../../apps/server/src/db/connection.js';
import { migrate } from '../../../apps/server/src/db/migrator.js';
import type { ClassId, StudentId } from '../../../apps/server/src/domain/types.js';
import { AuthSessions, hashSessionToken, type Clock, type SessionToken } from '../../../apps/server/src/auth/session.js';

let database: SqliteDatabase | undefined;
class MutableClock implements Clock { constructor(private value: Date) {} now(): Date { return this.value; } set(value: string): void { this.value = new Date(value); } }

function setup(): { repository: SqliteAuthSessionRepository; clock: MutableClock } {
  database = openSqlite(':memory:'); migrate(database);
  database.prepare('INSERT INTO app_settings (key,value,created_at_utc,updated_at_utc) VALUES (?,?,?,?)').run('teacher_shared_password_hash', '$argon2id$v=19$m=65536,t=3,p=1$test$safe', '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z');
  database.prepare('INSERT INTO classes (id,name,created_at_utc,updated_at_utc) VALUES (?,?,?,?)').run('class-1', '1A', '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z');
  database.prepare('INSERT INTO students (id,class_id,display_name,raw_student_number,normalized_student_number,is_temporary,approved_at_utc) VALUES (?,?,?,?,?,?,?)').run('student-1', 'class-1', 'Ada', 'a1', 'A1', 0, '2026-09-07T00:00:00.000Z');
  return { repository: new SqliteAuthSessionRepository(database), clock: new MutableClock(new Date('2026-09-07T00:00:00.000Z')) };
}
afterEach(() => database?.close());

describe('auth session SQLite repository', () => {
  it('reads only the configured password hash and persists only token hashes', () => {
    const { repository, clock } = setup();
    const sessions = new AuthSessions(repository, clock, () => 'browser-secret' as SessionToken);
    const login = sessions.createTeacherSession();
    expect(repository.teacherPasswordHash()).toContain('$argon2id$');
    expect(database?.prepare('SELECT token_hash FROM teacher_sessions').get()).toEqual({ token_hash: hashSessionToken(login.token) });
    expect(database?.prepare('SELECT token_hash FROM teacher_sessions').get()).not.toEqual({ token_hash: login.token });
  });

  it('rejects a second active student device without revoking the original session', () => {
    const { repository, clock } = setup();
    let counter = 0;
    const sessions = new AuthSessions(repository, clock, () => `token-${counter++}` as SessionToken);
    const student = { id: 'student-1' as StudentId, classId: 'class-1' as ClassId, displayName: 'Ada', rawStudentNumber: 'a1', normalizedStudentNumber: 'A1', isTemporary: false, approvedAtUtc: '2026-09-07T00:00:00.000Z' as never };
    const first = sessions.createStudentSession(student);
    expect(() => sessions.createStudentSession(student)).toThrow('STUDENT_SESSION_ALREADY_ACTIVE');
    expect(database?.prepare('SELECT revoked_at_utc FROM student_sessions WHERE id=?').get(first.session.id)).toEqual({ revoked_at_utc: null });
  });

  it('revokes an expired student session before allowing another device', () => {
    const { repository, clock } = setup();
    let counter = 0;
    const sessions = new AuthSessions(repository, clock, () => `token-${counter++}` as SessionToken);
    const student = { id: 'student-1' as StudentId, classId: 'class-1' as ClassId, displayName: 'Ada', rawStudentNumber: 'a1', normalizedStudentNumber: 'A1', isTemporary: false, approvedAtUtc: '2026-09-07T00:00:00.000Z' as never };
    const first = sessions.createStudentSession(student);
    clock.set('2026-09-07T02:00:00.000Z');
    const second = sessions.createStudentSession(student);
    expect(second.session.id).not.toBe(first.session.id);
    expect(database?.prepare('SELECT revoked_at_utc FROM student_sessions WHERE id=?').get(first.session.id)).toMatchObject({ revoked_at_utc: '2026-09-07T02:00:00.000Z' });
  });
});
