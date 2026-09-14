import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { io, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
import { createApplication } from '../../apps/server/src/application.js';
import { openSqlite, type SqliteDatabase } from '../../apps/server/src/db/connection.js';
import { migrate } from '../../apps/server/src/db/migrator.js';
import { startServer, type RunningServer } from '../../apps/server/src/server.js';

const origin = 'http://classroom.test';
type Login = Readonly<{ cookie: string; csrf: string }>;
type Change = Readonly<{ resourceType: string; id: string; version: number; event: string }>;

let database: SqliteDatabase | undefined;
let directory: string | undefined;
let server: RunningServer | undefined;
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.disconnect();
  await server?.close(); server = undefined;
  database?.close(); database = undefined;
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe('composed Socket.IO server', () => {
  it('authenticates real teacher/student sessions, scopes class changes, and exposes only invalidation hints', async () => {
    const base = await boot();
    const teacher = await teacherLogin(base);
    const classA = await createClass(base, teacher, '1A');
    const classB = await createClass(base, teacher, '1B');
    await importRoster(base, teacher, classA, 'Ada', 'A1');
    await importRoster(base, teacher, classB, 'Bea', 'B1');
    const studentA = await studentLogin(base, classA, 'Ada', 'A1');
    const studentB = await studentLogin(base, classB, 'Bea', 'B1');

    await expectRejectedSocket(base, 'teacher_session=forged');
    const teacherSocket = await connected(base, teacher.cookie);
    await subscribe(teacherSocket, classA);
    const studentASocket = await connected(base, studentA.cookie);
    const studentBSocket = await connected(base, studentB.cookie);
    await subscribe(studentASocket, classA);
    const crossClassError = onceValue(studentBSocket, 'realtime:error');
    studentBSocket.emit('class:subscribe', { classId: classA });
    expect(await crossClassError).toEqual({ code: 'CLASS_SCOPE_FORBIDDEN' });

    const pendingHint = waitForChange(teacherSocket, 'student_joined');
    const pending = await fetch(`${base}/api/classes/${classA}/join`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ displayName: 'Pending', studentNumber: 'P1' }) });
    expect(pending.status).toBe(202);
    expect(await pendingHint).toEqual(expect.objectContaining({ resourceType: 'roster', event: 'student_joined' }));

    const question = await draftQuestion(base, teacher, classA, 'What changed?');
    const teacherOpen = waitForChange(teacherSocket, 'question_opened');
    const studentAOpen = waitForChange(studentASocket, 'question_opened');
    const noCrossClassOpen = noChange(studentBSocket, 350);
    await post(base, `/api/questions/${question.id}/open`, teacher, {});
    const [teacherHint, studentHint] = await Promise.all([teacherOpen, studentAOpen]);
    await noCrossClassOpen;
    expect(teacherHint).toEqual(expect.objectContaining({ resourceType: 'question', id: question.id, event: 'question_opened', version: expect.any(Number) }));
    expect(Object.keys(teacherHint).sort()).toEqual(['event', 'id', 'resourceType', 'version']);
    const serializedHint = JSON.stringify(teacherHint);
    expect(serializedHint).not.toContain('Ada');
    expect(serializedHint).not.toContain('private answer');
    expect(serializedHint).not.toContain('answer.txt');
    expect(studentHint.id).toBe(question.id);

    let answerLeakedToStudent = false;
    studentASocket.once('class:changed', (hint: Change) => { answerLeakedToStudent ||= hint.event === 'answer_updated'; });
    const answerHint = waitForChange(teacherSocket, 'answer_updated');
    await post(base, `/api/questions/${question.id}/answers`, studentA, {
      revision: 0, idempotencyKey: 'answer-1', payload: { kind: 'short_text', text: 'private answer' }
    });
    expect(await answerHint).toEqual(expect.objectContaining({ resourceType: 'question', id: question.id, event: 'answer_updated' }));
    await pause(350);
    expect(answerLeakedToStudent).toBe(false);

    const teacherClose = waitForChange(teacherSocket, 'question_closed');
    const studentClose = waitForChange(studentASocket, 'question_closed');
    await post(base, `/api/questions/${question.id}/close`, teacher, {});
    await Promise.all([teacherClose, studentClose]);

    const task = await createFileTask(base, teacher, classA);
    const teacherFileOpen = waitForChange(teacherSocket, 'filetask_opened');
    const studentFileOpen = waitForChange(studentASocket, 'filetask_opened');
    await post(base, `/api/classes/${classA}/file-tasks/${task.id}/open`, teacher, {});
    await Promise.all([teacherFileOpen, studentFileOpen]);
    let uploadLeakedToStudent = false;
    studentASocket.once('class:changed', (hint: Change) => { uploadLeakedToStudent ||= hint.event === 'submission_committed'; });
    const submissionHint = waitForChange(teacherSocket, 'submission_committed');
    const uploaded = await fetch(`${base}/api/classes/${classA}/file-tasks/${task.id}/upload`, {
      method: 'POST', headers: { origin, cookie: studentA.cookie, 'x-csrf-token': studentA.csrf, 'x-upload-filename': 'answer.txt', 'content-type': 'text/plain' }, body: 'safe bytes'
    });
    expect(uploaded.status).toBe(201);
    expect(await submissionHint).toEqual(expect.objectContaining({ resourceType: 'submission', id: task.id, event: 'submission_committed' }));
    await pause(350);
    expect(uploadLeakedToStudent).toBe(false);

    const teacherFileClose = waitForChange(teacherSocket, 'filetask_closed');
    const studentFileClose = waitForChange(studentASocket, 'filetask_closed');
    await post(base, `/api/classes/${classA}/file-tasks/${task.id}/close`, teacher, {});
    await Promise.all([teacherFileClose, studentFileClose]);

    const disconnected = once(studentASocket, 'disconnect');
    await post(base, '/api/auth/logout', studentA, {});
    await disconnected;
  }, 15_000);

  it('admits 50 authenticated clients, reconnects, and shuts down the shared HTTP host cleanly', async () => {
    const base = await boot();
    const teacher = await teacherLogin(base);
    const classA = await createClass(base, teacher, 'Load class');
    const clients = await Promise.all(Array.from({ length: 50 }, () => connected(base, teacher.cookie)));
    await Promise.all(clients.map((client) => subscribe(client, classA)));
    const reconnect = once(clients[0]!, 'connect');
    clients[0]!.disconnect();
    clients[0]!.connect();
    await reconnect;
    await subscribe(clients[0]!, classA);
    const close = server?.close();
    server = undefined;
    await expect(close).resolves.toBeUndefined();
  }, 15_000);
});

async function boot(): Promise<string> {
  directory = mkdtempSync(join(tmpdir(), 'lan-classroom-realtime-'));
  database = openSqlite(join(directory, 'classroom.sqlite'));
  migrate(database);
  database.prepare("INSERT INTO app_settings (key,value,created_at_utc,updated_at_utc) VALUES ('teacher_shared_password_hash',?,?,?)")
    .run('$argon2id$test', '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z');
  const app = createApplication({ database, allowedOrigin: origin, csrfSecret: 'a'.repeat(32), passwordVerifier: async (password) => password === 'correct', uploadStorageRoot: join(directory, 'uploads'), realtimeSessionCheckMs: 1_000, realtimeHeartbeatMs: 2_000 });
  await app.reconcileUploads();
  server = await startServer({ host: '127.0.0.1', port: 0, apiHandler: app.apiHandler, realtime: app.realtime, onRealtimeGateway: (gateway) => app.realtimeNotifications.attach(gateway) });
  return `http://${server.host}:${server.port}`;
}

async function teacherLogin(base: string): Promise<Login> {
  const response = await fetch(`${base}/api/auth/teacher/login`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct' }) });
  expect(response.status).toBe(200);
  return login(response);
}

async function studentLogin(base: string, classId: string, displayName: string, studentNumber: string): Promise<Login> {
  const response = await fetch(`${base}/api/auth/student/join`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ classId, displayName, studentNumber }) });
  expect(response.status).toBe(200);
  return login(response);
}

async function login(response: Awaited<ReturnType<typeof fetch>>): Promise<Login> {
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  if (cookie === undefined) throw new Error('missing test session cookie');
  return { cookie, csrf: (await response.json() as { csrfToken: string }).csrfToken };
}

async function createClass(base: string, teacher: Login, name: string): Promise<string> {
  const response = await post(base, '/api/classes', teacher, { name });
  expect(response.status).toBe(201);
  return (await response.json() as { id: string }).id;
}

async function importRoster(base: string, teacher: Login, classId: string, name: string, number: string): Promise<void> {
  const response = await post(base, `/api/classes/${classId}/roster/import`, teacher, { csv: `name,studentNumber\n${name},${number}` });
  expect(response.status).toBe(200);
}

async function draftQuestion(base: string, teacher: Login, classId: string, prompt: string): Promise<Readonly<{ id: string }>> {
  const response = await post(base, `/api/classes/${classId}/question-drafts`, teacher, { question: { kind: 'short_text', prompt } });
  expect(response.status).toBe(201);
  return response.json() as Promise<{ id: string }>;
}

async function createFileTask(base: string, teacher: Login, classId: string): Promise<Readonly<{ id: string }>> {
  const response = await post(base, `/api/classes/${classId}/file-tasks`, teacher, { title: 'Upload', description: '', deadlineAtUtc: '2099-01-01T00:00:00.000Z' });
  expect(response.status).toBe(201);
  return response.json() as Promise<{ id: string }>;
}

function post(base: string, path: string, login: Login, body: unknown) {
  return fetch(`${base}${path}`, { method: 'POST', headers: { origin, cookie: login.cookie, 'x-csrf-token': login.csrf, 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

async function connected(base: string, cookie: string): Promise<Socket> {
  const socket = io(base, { path: '/socket.io', transports: ['websocket'], reconnection: false, extraHeaders: { origin, cookie } });
  sockets.push(socket);
  await once(socket, 'connect');
  return socket;
}

async function expectRejectedSocket(base: string, cookie: string): Promise<void> {
  const socket = io(base, { path: '/socket.io', transports: ['websocket'], reconnection: false, extraHeaders: { origin, cookie } });
  sockets.push(socket);
  await once(socket, 'connect_error');
}

async function subscribe(socket: Socket, classId: string): Promise<void> {
  const refetch = once(socket, 'class:refetch');
  socket.emit('class:subscribe', { classId });
  await refetch;
}

function waitForChange(socket: Socket, event: Change['event']): Promise<Change> {
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => { socket.off('class:changed', listener); reject(new Error(`timed out awaiting ${event}`)); }, 4_000);
    const listener = (change: Change) => {
      if (change.event !== event) return;
      globalThis.clearTimeout(timer);
      socket.off('class:changed', listener);
      resolve(change);
    };
    socket.on('class:changed', listener);
  });
}

function noChange(socket: Socket, milliseconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const listener = (change: Change) => { socket.off('class:changed', listener); reject(new Error(`unexpected cross-class change: ${change.event}`)); };
    socket.on('class:changed', listener);
    globalThis.setTimeout(() => { socket.off('class:changed', listener); resolve(); }, milliseconds);
  });
}

function once(socket: Socket, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => reject(new Error(`timed out awaiting ${event}`)), 4_000);
    socket.once(event, () => { globalThis.clearTimeout(timer); resolve(); });
  });
}

function onceValue(socket: Socket, event: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => reject(new Error(`timed out awaiting ${event}`)), 4_000);
    socket.once(event, (value: unknown) => { globalThis.clearTimeout(timer); resolve(value); });
  });
}

function pause(milliseconds: number): Promise<void> { return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds)); }
