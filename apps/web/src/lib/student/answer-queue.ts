import type { QueuedAnswer } from './types';

const DB_NAME = 'lan-classroom-student';
const STORE = 'unsynced-answers';

export interface AnswerQueue {
  put(answer: QueuedAnswer): Promise<void>;
  list(): Promise<readonly QueuedAnswer[]>;
  remove(id: string): Promise<void>;
}

export function createAnswerQueue(indexedDb: IDBFactory | undefined = globalThis.indexedDB): AnswerQueue {
  if (indexedDb === undefined) return memoryQueue();
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
    put: (answer) => transaction('readwrite', (store) => store.put(answer)).then(() => undefined),
    list: () => transaction('readonly', (store) => store.getAll()).then((items) => items.sort((a, b) => a.createdAt - b.createdAt)),
    remove: (id) => transaction('readwrite', (store) => store.delete(id)).then(() => undefined)
  };
}

function memoryQueue(): AnswerQueue {
  const answers = new Map<string, QueuedAnswer>();
  return { put: async (a) => { answers.set(a.id, a); }, list: async () => [...answers.values()], remove: async (id) => { answers.delete(id); } };
}

/** Sync always reads the current REST resource first; only then is the original idempotent request replayed. */
export async function flushAnswers(queue: AnswerQueue, sync: (answer: QueuedAnswer) => Promise<void>): Promise<void> {
  for (const answer of await queue.list()) {
    await sync(answer);
    await queue.remove(answer.id);
  }
}
