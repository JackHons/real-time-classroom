import { describe, expect, it } from 'vitest';
import { createAnswerQueue, flushAnswers } from '../../../apps/web/src/lib/student/answer-queue.js';
import type { QueuedAnswer } from '../../../apps/web/src/lib/student/types.js';

const answer: QueuedAnswer = {
  id: 'answer-1', questionId: 'question-1', revision: 0, idempotencyKey: 'same-request-on-retry',
  payload: { kind: 'short_text', text: '離線答案' }, createdAt: 10
};

describe('student answer queue', () => {
  it('keeps only answer payloads and removes one only after an idempotent sync', async () => {
    const queue = createAnswerQueue(undefined);
    await queue.put(answer);
    expect(await queue.list()).toEqual([answer]);
    const sent: QueuedAnswer[] = [];
    await flushAnswers(queue, async (queued) => { sent.push(queued); });
    expect(sent).toEqual([answer]);
    expect(await queue.list()).toEqual([]);
  });

  it('does not discard an answer when REST re-synchronisation fails', async () => {
    const queue = createAnswerQueue(undefined);
    await queue.put(answer);
    await expect(flushAnswers(queue, async () => { throw new Error('offline'); })).rejects.toThrow('offline');
    expect(await queue.list()).toEqual([answer]);
  });
});
