import { describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { studentApi } from '../../../apps/web/src/lib/student/api.js';
import { cleanupAnswerQueues, createAnswerQueue, flushAnswers } from '../../../apps/web/src/lib/student/answer-queue.js';
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

  it('deletes v1 ownerless-key records during a concurrent migration instead of replaying them', async () => {
    const indexedDb = new IDBFactory();
    await new Promise<void>((resolve, reject) => {
      const open = indexedDb.open('lan-classroom-student', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('unsynced-answers', { keyPath: 'id' }).put({ ...answer, owner: 'student-a' });
      open.onsuccess = () => { open.result.close(); resolve(); };
      open.onerror = () => reject(open.error);
    });
    const first = createAnswerQueue('student-a', indexedDb);
    const second = createAnswerQueue('student-b', indexedDb);
    const firstAnswer = { ...answer, id: 'first', createdAt: Date.now() };
    const secondAnswer = { ...answer, id: 'second', createdAt: Date.now() };
    await Promise.all([first.put(firstAnswer), second.put(secondAnswer)]);
    expect(await first.list()).toEqual([firstAnswer]);
    expect(await second.list()).toEqual([secondAnswer]);
  });

  it('keeps an eight-day unsynchronised owner when another owner creates and writes a queue', async () => {
    const indexedDb = new IDBFactory();
    const now = Date.now();
    const current = createAnswerQueue('current-session', indexedDb);
    const other = createAnswerQueue('other-session', indexedDb);
    const oldAnswer = { ...answer, id: 'old', createdAt: now - 8 * 24 * 60 * 60 * 1000 };
    const currentAnswer = { ...answer, id: 'current', createdAt: now };
    await current.put(oldAnswer);
    await other.put(currentAnswer);
    expect(await cleanupAnswerQueues(indexedDb)).toEqual({ recordCount: 2, storagePressure: false });
    expect(await current.list()).toEqual([oldAnswer]);
    expect(await other.list()).toEqual([currentAnswer]);
  });

  it('removes an owner only after that owner is explicitly discarded', async () => {
    const indexedDb = new IDBFactory();
    const previous = createAnswerQueue('previous-session', indexedDb);
    const current = createAnswerQueue('current-session', indexedDb);
    const currentAnswer = { ...answer, id: 'current', createdAt: Date.now() };
    await previous.put({ ...answer, id: 'previous', createdAt: Date.now() });
    await current.put(currentAnswer);
    await previous.discard();
    expect(await previous.list()).toEqual([]);
    expect(await current.list()).toEqual([currentAnswer]);
  });

  it('reports storage pressure at the global target without deleting another owner', async () => {
    const indexedDb = new IDBFactory();
    const queues = Array.from({ length: 101 }, (_, index) => createAnswerQueue(`session-${index}`, indexedDb));
    let maintenance = await queues[0].put({ ...answer, id: 'answer-0', createdAt: Date.now() - 8 * 24 * 60 * 60 * 1000 });
    for (let index = 1; index < queues.length; index += 1) {
      maintenance = await queues[index].put({ ...answer, id: `answer-${index}`, createdAt: Date.now() + index });
    }
    expect(maintenance).toEqual({ recordCount: 101, storagePressure: true });
    expect(await queues[0].list()).toEqual([{ ...answer, id: 'answer-0', createdAt: expect.any(Number) }]);
  });

  it('allows same-owner tabs to write concurrently without either queue deleting the other answer', async () => {
    const indexedDb = new IDBFactory();
    const firstTab = createAnswerQueue('shared-session', indexedDb);
    const secondTab = createAnswerQueue('shared-session', indexedDb);
    const firstAnswer = { ...answer, id: 'first-tab', createdAt: Date.now() };
    const secondAnswer = { ...answer, id: 'second-tab', createdAt: Date.now() + 1 };
    await Promise.all([firstTab.put(firstAnswer), secondTab.put(secondAnswer)]);
    expect(await firstTab.list()).toEqual([firstAnswer, secondAnswer]);
    expect(await secondTab.list()).toEqual([firstAnswer, secondAnswer]);
  });

  it('does not discard a previous owner merely because a new session is restored', async () => {
    const indexedDb = new IDBFactory();
    const previous = createAnswerQueue('previous-session', indexedDb);
    const previousAnswer = { ...answer, id: 'previous-session-answer', createdAt: Date.now() - 8 * 24 * 60 * 60 * 1000 };
    await previous.put(previousAnswer);
    const originalFetch = globalThis.fetch;
    const originalIndexedDb = globalThis.indexedDB;
    try {
      globalThis.indexedDB = indexedDb;
      globalThis.fetch = vi.fn()
        .mockResolvedValueOnce(new globalThis.Response(JSON.stringify({ actor: 'student', classId: 'class-1', sessionId: 'new-session' })))
        .mockResolvedValueOnce(new globalThis.Response(JSON.stringify({ csrfToken: 'csrf-token' }))) as typeof globalThis.fetch;
      await expect(studentApi.restoreSession()).resolves.toEqual({ classId: 'class-1', queueOwner: 'student-session:new-session' });
      expect(await previous.list()).toEqual([previousAnswer]);
      const restored = createAnswerQueue('student-session:new-session', indexedDb);
      await restored.put({ ...answer, id: 'restored-session-answer', createdAt: Date.now() });
      await studentApi.endSession();
      expect(await restored.list()).toEqual([]);
      expect(await previous.list()).toEqual([previousAnswer]);
    } finally {
      await studentApi.endSession();
      globalThis.fetch = originalFetch;
      globalThis.indexedDB = originalIndexedDb;
    }
  });
});
