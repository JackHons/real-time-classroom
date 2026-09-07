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
});
