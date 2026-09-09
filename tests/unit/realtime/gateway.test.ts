import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../../../apps/server/src/server.js';
import type { RealtimeGateway } from '../../../apps/server/src/realtime/gateway.js';
import type { ClassId } from '../../../apps/server/src/domain/types.js';

const origin = 'http://127.0.0.1:4173';
const teacherCookie = 'teacher_session=valid-teacher-cookie';
let running: RunningServer | undefined;

afterEach(async () => { await running?.close(); running = undefined; });

describe('realtime gateway', () => {
  it('rejects a forged cookie after the Engine handshake and rejects a non-exact Origin before it', async () => {
    running = await gatewayServer();
    const base = `http://127.0.0.1:${running.port}`;
    const rejectedOrigin = await fetch(`${base}/socket.io/?EIO=4&transport=polling`, { headers: { origin: 'http://evil.example' } });
    expect(rejectedOrigin.status).toBe(403);

    const sid = await handshake(base, 'teacher_session=forged');
    await packet(base, sid, '40', 'teacher_session=forged');
    const response = await poll(base, sid, 'teacher_session=forged');
    expect(response).toContain('REALTIME_AUTH_REQUIRED');
  });

  it('scopes notification-only changes to an authenticated classroom and never sends sensitive fields', async () => {
    let gateway: RealtimeGateway | undefined;
    running = await gatewayServer((attached) => { gateway = attached; });
    const base = `http://127.0.0.1:${running.port}`;
    const sid = await connectedTeacher(base);
    await packet(base, sid, '42["class:subscribe",{"classId":"class-a"}]', teacherCookie);
    // Flush the subscription's REST-refetch prompt before testing the change.
    await poll(base, sid, teacherCookie);
    if (gateway === undefined) throw new Error('gateway was not attached');
    // Volatile notifications are delivered only while this polling transport
    // is writable; otherwise the client will receive the next REST refetch.
    const waiting = poll(base, sid, teacherCookie);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
    gateway.publish({ classId: 'class-a' as ClassId, resourceType: 'question', id: 'question-a', event: 'question_opened' });
    const response = await waiting;
    expect(response).toContain('class:changed');
    expect(response).toContain('"resourceType":"question"');
    expect(response).toContain('"id":"question-a"');
    expect(response).toMatch(/"version":\d+/);
    expect(response).not.toMatch(/referenceAnswer|selectedOptions|studentId|displayName|filename/i);
  });

  it('rejects a teacher subscription outside the authorization port', async () => {
    running = await gatewayServer();
    const base = `http://127.0.0.1:${running.port}`;
    const sid = await connectedTeacher(base);
    await packet(base, sid, '42["class:subscribe",{"classId":"class-b"}]', teacherCookie);
    expect(await poll(base, sid, teacherCookie)).toContain('CLASS_SCOPE_FORBIDDEN');
  });

  it('admits 50 clients and handles a reconnect burst within the configured ceiling', async () => {
    running = await gatewayServer();
    const base = `http://127.0.0.1:${running.port}`;
    const firstWave = await Promise.all(Array.from({ length: 50 }, () => connectedTeacher(base)));
    await Promise.all(firstWave.map((sid) => packet(base, sid, '41', teacherCookie)));
    const secondWave = await Promise.all(Array.from({ length: 50 }, () => connectedTeacher(base)));
    expect(secondWave).toHaveLength(50);
  });
});

async function gatewayServer(onGateway?: (gateway: RealtimeGateway) => void): Promise<RunningServer> {
  return startServer({
    host: '127.0.0.1',
    port: 0,
    realtime: {
      allowedOrigin: origin,
      authenticateTeacher: (token) => token === 'valid-teacher-cookie' ? { teacherSessionId: 'teacher-session-a' } : undefined,
      authenticateStudent: () => undefined,
      canTeacherAccessClass: (_teacher, classId) => classId === 'class-a',
      sessionCheckMs: 1_000,
      heartbeatMs: 5_000
    },
    ...(onGateway === undefined ? {} : { onRealtimeGateway: onGateway })
  });
}

async function connectedTeacher(base: string): Promise<string> {
  const sid = await handshake(base, teacherCookie);
  await packet(base, sid, '40', teacherCookie);
  return sid;
}
async function handshake(base: string, cookie: string): Promise<string> {
  const response = await fetch(`${base}/socket.io/?EIO=4&transport=polling`, { headers: { origin, cookie } });
  expect(response.status).toBe(200);
  const payload = await response.text();
  const match = /^0(\{.*\})$/.exec(payload);
  if (match?.[1] === undefined) throw new Error(`Engine.IO handshake failed: ${payload}`);
  return (JSON.parse(match[1]) as { sid: string }).sid;
}
async function packet(base: string, sid: string, value: string, cookie: string): Promise<void> {
  const response = await fetch(`${base}/socket.io/?EIO=4&transport=polling&sid=${encodeURIComponent(sid)}`, {
    method: 'POST', headers: { origin, cookie, 'content-type': 'text/plain;charset=UTF-8' }, body: value
  });
  expect(response.status).toBe(200);
}
async function poll(base: string, sid: string, cookie: string): Promise<string> {
  const response = await fetch(`${base}/socket.io/?EIO=4&transport=polling&sid=${encodeURIComponent(sid)}`, { headers: { origin, cookie } });
  expect(response.status).toBe(200);
  return response.text();
}
