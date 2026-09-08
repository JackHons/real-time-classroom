/* global IDBFactory, IDBDatabase, IDBTransactionMode, IDBObjectStore, IDBRequest */
import type { QueuedAnswer } from './types';

const DB_NAME = 'lan-classroom-student';
const STORE = 'unsynced-answers';
const DB_VERSION = 2;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RECORDS = 100;

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
 * The server permits one student cookie per browser. Once it confirms a new
 * owner, every other namespace is orphaned answer JSON and must not replay.
 */
export async function discardOtherAnswerQueueOwners(currentOwner: string | undefined, indexedDb: IDBFactory | undefined = globalThis.indexedDB): Promise<void> {
  if (indexedDb === undefined) return;
  const db = await openDatabase(indexedDb);
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    const request = transaction.objectStore(STORE).openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor === null) return;
      if (cursor.value.owner !== currentOwner) cursor.delete();
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

/** Bound local-only answer JSON retention. The current owner is protected from expiry, but not the hard cap. */
export async function cleanupAnswerQueues(indexedDb: IDBFactory | undefined = globalThis.indexedDB, protectedOwner?: string, now = Date.now()): Promise<void> {
  if (indexedDb === undefined) return;
  const database = openDatabase(indexedDb);
  const db = await database;
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    const request = store.getAll();
    request.onsuccess = () => {
      const records = request.result as StoredAnswer[];
      const stale = records.filter((record) => record.owner !== protectedOwner && record.createdAt < now - MAX_AGE_MS);
      for (const record of stale) store.delete([record.owner, record.id]);
      const remaining = records.filter((record) => !stale.includes(record)).sort((a, b) => a.createdAt - b.createdAt);
      let excess = Math.max(0, remaining.length - MAX_RECORDS);
      const evictionOrder = [...remaining.filter((record) => record.owner !== protectedOwner), ...remaining.filter((record) => record.owner === protectedOwner)];
      for (const record of evictionOrder) {
        if (excess === 0) break;
        store.delete([record.owner, record.id]);
        excess -= 1;
      }
    };
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export function createAnswerQueue(owner: string, indexedDb: IDBFactory | undefined = globalThis.indexedDB): AnswerQueue {
  if (owner.length === 0) throw new Error('ANSWER_QUEUE_OWNER_REQUIRED');
  if (indexedDb === undefined) return memoryQueue(owner);
  const database = openDatabase(indexedDb);
  // Startup retention is best-effort and never delays answering.
  void cleanupAnswerQueues(indexedDb, owner);
  return {
    put: (answer) => inTransaction(database, 'readwrite', (store) => store.put({ ...answer, owner })).then(async () => { await cleanupAnswerQueues(indexedDb, owner); }),
    list: () => inTransaction<StoredAnswer[]>(database, 'readonly', (store) => store.index('owner').getAll(owner)).then((items) => items.sort((a, b) => a.createdAt - b.createdAt).map(answerOnly)),
    remove: (id) => inTransaction(database, 'readwrite', (store) => store.delete([owner, id])).then(() => undefined),
    discard: () => discardOwner(database, owner)
  };
}

const memoryAnswers = new Map<string, StoredAnswer>();
function memoryQueue(owner: string): AnswerQueue {
  const key = (id: string): string => `${owner}\u0000${id}`;
  return {
    put: async (answer) => { memoryAnswers.set(key(answer.id), { ...answer, owner }); },
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
