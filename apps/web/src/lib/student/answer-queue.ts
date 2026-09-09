/* global IDBFactory, IDBDatabase, IDBTransactionMode, IDBObjectStore, IDBRequest */
import type { QueuedAnswer } from './types';

const DB_NAME = 'lan-classroom-student';
const STORE = 'unsynced-answers';
const DB_VERSION = 2;
const MAX_RECORDS = 100;

/**
 * Queue entries are never evicted while they are unsynchronised. Reaching the
 * local retention target is advisory: callers can warn the student, but must
 * not silently trade one owner's answer for another owner's answer.
 */
export type AnswerQueueMaintenance = Readonly<{
  recordCount: number;
  storagePressure: boolean;
}>;

export interface AnswerQueue {
  put(answer: QueuedAnswer): Promise<AnswerQueueMaintenance>;
  list(): Promise<readonly QueuedAnswer[]>;
  remove(id: string): Promise<void>;
  /** Removes only this browser-session namespace; it never touches another student. */
  discard(): Promise<void>;
}

type StoredAnswer = QueuedAnswer & Readonly<{ owner: string }>;
function answerOnly(item: StoredAnswer): QueuedAnswer {
  return { id: item.id, questionId: item.questionId, revision: item.revision, idempotencyKey: item.idempotencyKey, payload: item.payload, createdAt: item.createdAt };
}

function openDatabase(indexedDb: IDBFactory): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDb.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const database = open.result;
      // V1 was keyed only by answer id and cannot establish safe ownership.
      if (database.objectStoreNames.contains(STORE)) database.deleteObjectStore(STORE);
      const store = database.createObjectStore(STORE, { keyPath: ['owner', 'id'] });
      store.createIndex('owner', 'owner', { unique: false });
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

async function inTransaction<T>(database: Promise<IDBDatabase>, mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database;
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = work(transaction.objectStore(STORE));
    let result: T;
    request.onsuccess = () => { result = request.result; };
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => resolve(result!);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function discardOwner(database: Promise<IDBDatabase>, owner: string): Promise<void> {
  const db = await database;
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    const request = transaction.objectStore(STORE).index('owner').openCursor(owner);
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor === null) return;
      cursor.delete();
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

/** Deletes only a known former session. Other owners remain untouched. */
export async function discardAnswerQueueOwner(owner: string | undefined, indexedDb: IDBFactory | undefined = globalThis.indexedDB): Promise<void> {
  if (owner === undefined || indexedDb === undefined) return;
  await discardOwner(openDatabase(indexedDb), owner);
}

/**
 * Inspect local retention without evicting answer JSON. Age cannot prove an
 * owner logged out or expired, and a global cap must not delete another
 * owner's still-replayable answer. V1 ownerless records are removed during
 * the database migration because they have no safe namespace.
 */
export async function cleanupAnswerQueues(indexedDb: IDBFactory | undefined = globalThis.indexedDB): Promise<AnswerQueueMaintenance> {
  if (indexedDb === undefined) return { recordCount: memoryAnswers.size, storagePressure: memoryAnswers.size >= MAX_RECORDS };
  const records = await inTransaction<StoredAnswer[]>(openDatabase(indexedDb), 'readonly', (store) => store.getAll());
  return { recordCount: records.length, storagePressure: records.length >= MAX_RECORDS };
}

export function createAnswerQueue(owner: string, indexedDb: IDBFactory | undefined = globalThis.indexedDB): AnswerQueue {
  if (owner.length === 0) throw new Error('ANSWER_QUEUE_OWNER_REQUIRED');
  if (indexedDb === undefined) return memoryQueue(owner);
  const database = openDatabase(indexedDb);
  // Startup inspection is best-effort and never delays answering.
  void cleanupAnswerQueues(indexedDb);
  return {
    put: (answer) => inTransaction(database, 'readwrite', (store) => store.put({ ...answer, owner })).then(async () => cleanupAnswerQueues(indexedDb)),
    list: () => inTransaction<StoredAnswer[]>(database, 'readonly', (store) => store.index('owner').getAll(owner)).then((items) => items.sort((a, b) => a.createdAt - b.createdAt).map(answerOnly)),
    remove: (id) => inTransaction(database, 'readwrite', (store) => store.delete([owner, id])).then(() => undefined),
    discard: () => discardOwner(database, owner)
  };
}

const memoryAnswers = new Map<string, StoredAnswer>();
function memoryQueue(owner: string): AnswerQueue {
  const key = (id: string): string => `${owner}\u0000${id}`;
  return {
    put: async (answer) => {
      memoryAnswers.set(key(answer.id), { ...answer, owner });
      return { recordCount: memoryAnswers.size, storagePressure: memoryAnswers.size >= MAX_RECORDS };
    },
    list: async () => [...memoryAnswers.values()].filter((answer) => answer.owner === owner).sort((a, b) => a.createdAt - b.createdAt).map(answerOnly),
    remove: async (id) => { memoryAnswers.delete(key(id)); },
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
