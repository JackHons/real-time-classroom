import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqlite, type SqliteDatabase } from '../../../../apps/server/src/db/connection.js';
import { migrate } from '../../../../apps/server/src/db/migrator.js';
import { SqliteDomainRepository } from '../../../../apps/server/src/db/sqlite-repositories.js';
import { SqliteLiveQuestionRepository } from '../../../../apps/server/src/db/live-question-repository.js';
import type { ClassId, StudentId } from '../../../../apps/server/src/domain/types.js';

let database: SqliteDatabase | undefined;
afterEach(() => database?.close());

function setup(): { domain: SqliteDomainRepository; live: SqliteLiveQuestionRepository } {
  database = openSqlite(':memory:'); migrate(database);
  let tick = 0;
  const domain = new SqliteDomainRepository(database, () => `2026-09-07T00:00:${String(tick++).padStart(2, '0')}.000Z`);
  domain.createClass({ id: 'class-1' as ClassId, name: '1A', createdAtUtc: '2026-09-07T00:00:00.000Z' as never, updatedAtUtc: '2026-09-07T00:00:00.000Z' as never });
  for (const id of ['student-1', 'student-2']) domain.createStudent({ id: id as StudentId, classId: 'class-1' as ClassId, displayName: id, rawStudentNumber: id, normalizedStudentNumber: id, isTemporary: false, approvedAtUtc: '2026-09-07T00:00:00.000Z' as never });
  domain.createQuestion({ id: 'q1' as never, classId: 'class-1' as ClassId, kind: 'multiple_choice', prompt: 'Pick', options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] });
  return { domain, live: new SqliteLiveQuestionRepository(database, domain) };
}

describe('SQLite live question adapter', () => {
  it('reads anonymous open aggregation and keeps immutable close answers despite a late write', () => {
    const { domain, live } = setup();
    live.open('q1' as never);
    domain.submitAnswer('student-1' as StudentId, { questionId: 'q1' as never, revision: 1, idempotencyKey: 'first', requestFingerprint: 'first', payload: { kind: 'multiple_choice', selectedOptions: ['a', 'b'] } });
    expect(live.openAggregate('q1' as never)).toEqual({ eligibleStudentCount: 2, answeredStudentCount: 1, counts: { a: 1, b: 1 }, shortTextResponseCount: 0 });
    const snapshot = live.close('q1' as never);
    domain.submitAnswer('student-1' as StudentId, { questionId: 'q1' as never, revision: 2, idempotencyKey: 'late', requestFingerprint: 'late', payload: { kind: 'multiple_choice', selectedOptions: ['b'] } });
    expect(snapshot.counts).toEqual({ a: 1, b: 1 });
    expect(live.answerAtClose('q1' as never, 'student-1' as StudentId)?.payload).toEqual({ kind: 'multiple_choice', selectedOptions: ['a', 'b'] });
    expect(live.closedAnswers('q1' as never)).toHaveLength(2);
  });

  it('uses only close-time roster snapshots for named closed answers', () => {
    const { domain, live } = setup();
    live.open('q1' as never);
    domain.submitAnswer('student-1' as StudentId, { questionId: 'q1' as never, revision: 1, idempotencyKey: 'first', requestFingerprint: 'first', payload: { kind: 'multiple_choice', selectedOptions: ['a'] } });
    live.close('q1' as never);
    database?.prepare("UPDATE students SET display_name='Renamed', raw_student_number='NEW-1' WHERE id='student-1'").run();
    database?.prepare("INSERT INTO students (id,class_id,display_name,raw_student_number,normalized_student_number,is_temporary,approved_at_utc) VALUES ('student-late','class-1','Late','LATE', 'LATE',0,'2026-09-07T00:00:00.000Z')").run();
    database?.prepare("DELETE FROM students WHERE id='student-2'").run();
    expect(live.closedAnswers('q1' as never)).toEqual([
      expect.objectContaining({ studentId: 'student-1', displayName: 'student-1', studentNumber: 'student-1' }),
      expect.objectContaining({ studentId: 'student-2', displayName: 'student-2', studentNumber: 'student-2' })
    ]);
  });

  it('keeps pre-snapshot close rows readable without consulting the current roster', () => {
    database = openSqlite(':memory:');
    database.exec(readFileSync(new URL('../../../../apps/server/src/db/migrations/0001_initial.sql', import.meta.url), 'utf8'));
    database.exec("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at_utc TEXT NOT NULL); INSERT INTO schema_migrations VALUES ('0001_initial','2026-09-07T00:00:00.000Z');");
    const domain = new SqliteDomainRepository(database, () => '2026-09-07T00:00:00.000Z');
    domain.createClass({ id: 'class-legacy' as ClassId, name: 'Legacy', createdAtUtc: '2026-09-07T00:00:00.000Z' as never, updatedAtUtc: '2026-09-07T00:00:00.000Z' as never });
    domain.createStudent({ id: 'student-legacy' as StudentId, classId: 'class-legacy' as ClassId, displayName: 'Old name', rawStudentNumber: 'OLD-1', normalizedStudentNumber: 'OLD-1', isTemporary: false, approvedAtUtc: '2026-09-07T00:00:00.000Z' as never });
    domain.createQuestion({ id: 'q-legacy' as never, classId: 'class-legacy' as ClassId, kind: 'short_text', prompt: 'Legacy?', options: [] });
    // This represents a durable 0001 close row created before the 0002
    // snapshot columns and before the current write adapter existed.
    database.prepare("UPDATE questions SET state='closed', opened_at_utc=?, closed_at_utc=? WHERE id=?").run('2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z', 'q-legacy');
    database.prepare('INSERT INTO answer_at_close (question_id,student_id,revision,submitted_at_utc,payload_json,no_answer,closed_at_utc) VALUES (?,?,?,?,?,?,?)')
      .run('q-legacy', 'student-legacy', null, null, null, 1, '2026-09-07T00:00:00.000Z');
    migrate(database);
    database.prepare("UPDATE students SET display_name='Changed' WHERE id='student-legacy'").run();
    const live = new SqliteLiveQuestionRepository(database, domain);
    expect(live.closedAnswers('q-legacy' as never)).toEqual([expect.objectContaining({ displayName: 'Unknown student', studentNumber: 'Unknown' })]);
  });
});
