import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createUploadRoutes } from '../../../apps/server/src/uploads/http-routes.js';
import { UploadStorage } from '../../../apps/server/src/uploads/storage.js';
import type { UploadRouteDependencies } from '../../../apps/server/src/uploads/http-routes.js';

function request(headers: Record<string, string> = {}): PassThrough & IncomingMessage {
  const value = new PassThrough() as PassThrough & IncomingMessage;
  value.method = 'POST'; value.url = '/api/classes/class-1/file-tasks/task-1/upload'; value.headers = headers;
  return value;
}
function response(): ServerResponse { return { writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse; }
function dependencies(pipeline: UploadRouteDependencies['pipeline'], task = { id: 'task-1', classId: 'class-1', state: 'open' }): UploadRouteDependencies {
  return { pipeline, repository: { task: () => task as never, studentSubmission: () => undefined }, storage: new UploadStorage('C:/unused-upload-route-test'), studentContext: () => ({ studentId: 'student-1' as never, classId: 'class-1' as never }), teacherContext: () => ({}) };
}

describe('upload HTTP routes', () => {
  it('rejects an invalid or oversized Content-Length before pipeline admission and drains the request', async () => {
    const ingest = vi.fn();
    const handler = createUploadRoutes(dependencies({ ingest }));
    const malformed = request({ 'content-length': 'NaN' });
    await expect(handler(malformed, response())).rejects.toThrow('UPLOAD_INVALID_CONTENT_LENGTH');
    const oversized = request({ 'content-length': '100000001' });
    await expect(handler(oversized, response())).rejects.toThrow('UPLOAD_TOO_LARGE');
    expect(ingest).not.toHaveBeenCalled();
  });

  it('rejects a class/task mismatch before bytes are admitted', async () => {
    const ingest = vi.fn();
    const handler = createUploadRoutes(dependencies({ ingest }, { id: 'task-1', classId: 'other-class', state: 'open' }));
    const input = request(); input.end('payload');
    await expect(handler(input, response())).rejects.toThrow('FILE_TASK_NOT_FOUND');
    expect(ingest).not.toHaveBeenCalled();
  });

  it('aborts ten idle streams, waits for them to settle, and frees every admission slot', async () => {
    let active = 0;
    const pipeline: UploadRouteDependencies['pipeline'] = {
      ingest: async ({ bytes }) => {
        active += 1;
        try { for await (const chunk of bytes) { void chunk; } return { byteLength: 0, sha256: '0'.repeat(64), receivedCompleteAtUtc: 'now' }; }
        finally { active -= 1; }
      }
    };
    const handler = createUploadRoutes({ ...dependencies(pipeline), idleTimeoutMs: 5, absoluteRequestTimeoutMs: 20 });
    const streams = Array.from({ length: 10 }, () => request());
    const outcomes = await Promise.all(streams.map(async (input) => {
      try { await handler(input, response()); return 'unexpected'; }
      catch (error) { return error instanceof Error ? error.message : 'unknown'; }
    }));
    expect(outcomes).toEqual(Array(10).fill('UPLOAD_IDLE_TIMEOUT'));
    expect(active).toBe(0);
    expect(streams.every((input) => input.destroyed)).toBe(true);
  });

  it('enforces an absolute deadline even when a slow stream keeps resetting the idle timer', async () => {
    const pipeline: UploadRouteDependencies['pipeline'] = {
      ingest: async ({ bytes }) => { for await (const chunk of bytes) void chunk; return { byteLength: 0, sha256: '0'.repeat(64), receivedCompleteAtUtc: 'now' }; }
    };
    const handler = createUploadRoutes({ ...dependencies(pipeline), idleTimeoutMs: 10, absoluteRequestTimeoutMs: 30 });
    const input = request();
    const interval = globalThis.setInterval(() => { if (!input.destroyed) input.write('x'); }, 2);
    try { await expect(handler(input, response())).rejects.toThrow('UPLOAD_REQUEST_DEADLINE_EXCEEDED'); }
    finally { globalThis.clearInterval(interval); }
    expect(input.destroyed).toBe(true);
  });
});
