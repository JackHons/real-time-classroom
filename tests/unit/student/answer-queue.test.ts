import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { cleanupAnswerQueues, createAnswerQueue, discardOtherAnswerQueueOwners, flushAnswers } from '../../../apps/web/src/lib/student/answer-queue.js';
import type { QueuedAnswer } from '../../../apps/web/src/lib/student/types.js';

const answer: QueuedAnswer = {
  id: 'answer-1', questionId: 'question-1', revision: 0, idempotencyKey: 'same-request-on-retry',
  payload: { kind: 'short_text', text: '離線答案' }, createdAt: 10
};

describe('student answer queue', () => {
  it('keeps only answer payloads and removes one only after an idempotent sync', async () => {
    const queue = createAnswerQueue('student-a-session-1', undefined);
    await queue.put(answer);
    expect(await queue.list()).toEqual([answer]);
    const sent: QueuedAnswer[] = [];
    await flushAnswers(queue, async (queued) => { sent.push(queued); });
    expect(sent).toEqual([answer]);
    expect(await queue.list()).toEqual([]);
  });

  it('does not discard an answer when REST re-synchronisation fails', async () => {
    const queue = createAnswerQueue('student-a-session-1', undefined);
    await queue.put(answer);
    await expect(flushAnswers(queue, async () => { throw new Error('offline'); })).rejects.toThrow('offline');
    expect(await queue.list()).toEqual([answer]);
  });

  it('never exposes or flushes a previous student owner after a session switch', async () => {
    const previous = createAnswerQueue('student-a-session-1', undefined);
    const current = createAnswerQueue('student-b-session-2', undefined);
    await previous.put(answer);
    expect(await current.list()).toEqual([]);
    const sent: QueuedAnswer[] = [];
    await flushAnswers(current, async (queued) => { sent.push(queued); });
    expect(sent).toEqual([]);
    expect(await previous.list()).toEqual([answer]);
    await previous.discard();
    expect(await previous.list()).toEqual([]);
  });

  it('allows different owners to retain answers with the same id, without cross-owner removal', async () => {
    const indexedDb = new IDBFactory();
    const first = createAnswerQueue('student-a', indexedDb);
    const second = createAnswerQueue('student-b', indexedDb);
    const firstAnswer = { ...answer, createdAt: Date.now(), payload: { kind: 'short_text' as const, text: 'A' } };
    const secondAnswer = { ...firstAnswer, payload: { kind: 'short_text' as const, text: 'B' } };
    await first.put(firstAnswer);
    await second.put(secondAnswer);
    await second.remove(answer.id);
    expect(await first.list()).toEqual([firstAnswer]);
    expect(await second.list()).toEqual([]);
  });

  it('keeps another owner safe while a discard and write race', async () => {
    const indexedDb = new IDBFactory();
    const first = createAnswerQueue('student-a', indexedDb);
    const second = createAnswerQueue('student-b', indexedDb);
    const firstAnswer = { ...answer, createdAt: Date.now() };
    const secondAnswer = { ...firstAnswer, payload: { kind: 'short_text' as const, text: 'other session' } };
    await first.put(firstAnswer);
    await Promise.all([first.discard(), second.put(secondAnswer)]);
    expect(await first.list()).toEqual([]);
    expect(await second.list()).toEqual([secondAnswer]);
  });

  it('deletes v1 ownerless-key records during migration instead of replaying them', async () => {
    const indexedDb = new IDBFactory();
    await new Promise<void>((resolve, reject) => {
      const open = indexedDb.open('lan-classroom-student', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('unsynced-answers', { keyPath: 'id' }).put({ ...answer, owner: 'student-a' });
      open.onsuccess = () => { open.result.close(); resolve(); };
      open.onerror = () => reject(open.error);
    });
    const migrated = createAnswerQueue('student-a', indexedDb);
    expect(await migrated.list()).toEqual([]);
  });

  it('removes expired orphan owners but preserves the active owner', async () => {
    const indexedDb = new IDBFactory();
    const now = Date.now();
    const expired = createAnswerQueue('old-session', indexedDb);
    const active = createAnswerQueue('active-session', indexedDb);
    const oldAnswer = { ...answer, id: 'old', createdAt: now - 8 * 24 * 60 * 60 * 1000 };
    const activeAnswer = { ...answer, id: 'active', createdAt: oldAnswer.createdAt };
    await expired.put(oldAnswer);
    await active.put(activeAnswer);
    await cleanupAnswerQueues(indexedDb, 'active-session', now);
    expect(await expired.list()).toEqual([]);
    expect(await active.list()).toEqual([activeAnswer]);
  });

  it('clears prior-owner answer JSON when a server-confirmed new owner starts', async () => {
    const indexedDb = new IDBFactory();
    const previous = createAnswerQueue('previous-session', indexedDb);
    const current = createAnswerQueue('current-session', indexedDb);
    const currentAnswer = { ...answer, id: 'current', createdAt: Date.now() };
    await previous.put({ ...answer, id: 'previous', createdAt: Date.now() });
    await current.put(currentAnswer);
    await discardOtherAnswerQueueOwners('current-session', indexedDb);
    expect(await previous.list()).toEqual([]);
    expect(await current.list()).toEqual([currentAnswer]);
  });
});
