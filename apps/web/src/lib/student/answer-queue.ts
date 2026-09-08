/* global IDBFactory, IDBDatabase, IDBTransactionMode, IDBObjectStore, IDBRequest */
import type { QueuedAnswer } from './types';

const DB_NAME = 'lan-classroom-student';
const STORE = 'unsynced-answers';

export interface AnswerQueue {
  put(answer: QueuedAnswer): Promise<void>;
  list(): Promise<readonly QueuedAnswer[]>;
  remove(id: string): Promise<void>;
  /** Removes only this browser-session namespace; it never touches another student. */
  discard(): Promise<void>;
}

type StoredAnswer = QueuedAnswer & Readonly<{ owner: string }>;
function answerOnly(item: StoredAnswer): QueuedAnswer {
  return { id: item.id, questionId: item.questionId, revision: item.revision, idempotencyKey: item.idempotencyKey, payload: item.payload, createdAt: item.createdAt };
}

export function createAnswerQueue(owner: string, indexedDb: IDBFactory | undefined = globalThis.indexedDB): AnswerQueue {
  if (owner.length === 0) throw new Error('ANSWER_QUEUE_OWNER_REQUIRED');
  if (indexedDb === undefined) return memoryQueue(owner);
  const database = new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDb.open(DB_NAME, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE, { keyPath: 'id' });
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  const transaction = async <T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await database;
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = work(tx.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  };
  return {
    put: (answer) => transaction('readwrite', (store) => store.put({ ...answer, owner })).then(() => undefined),
    // Filtering happens before exposing a record, so an owner switch cannot
    // replay or even read a previous student's payload.
    list: () => transaction<StoredAnswer[]>('readonly', (store) => store.getAll()).then((items) => items
      .filter((item) => item.owner === owner)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(answerOnly)),
    remove: (id) => transaction('readwrite', (store) => store.delete(id)).then(() => undefined)
    , discard: async () => {
      for (const answer of await transaction<StoredAnswer[]>('readonly', (store) => store.getAll())) {
        if (answer.owner === owner) await transaction('readwrite', (store) => store.delete(answer.id));
      }
    }
  };
}

const memoryAnswers = new Map<string, StoredAnswer>();
function memoryQueue(owner: string): AnswerQueue {
  return {
    put: async (answer) => { memoryAnswers.set(answer.id, { ...answer, owner }); },
    list: async () => [...memoryAnswers.values()].filter((answer) => answer.owner === owner).map(answerOnly),
    remove: async (id) => { const answer = memoryAnswers.get(id); if (answer?.owner === owner) memoryAnswers.delete(id); },
    discard: async () => { for (const [id, answer] of memoryAnswers) if (answer.owner === owner) memoryAnswers.delete(id); }
  };
}

/** Sync always reads the current REST resource first; only then is the original idempotent request replayed. */
export async function flushAnswers(queue: AnswerQueue, sync: (answer: QueuedAnswer) => Promise<void>): Promise<void> {
  for (const answer of await queue.list()) {
    await sync(answer);
    await queue.remove(answer.id);
  }
}
