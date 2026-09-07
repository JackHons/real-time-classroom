import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { ClassService } from '../../../apps/server/src/classes/class-service.js';
import { createClassRoutes } from '../../../apps/server/src/classes/http-routes.js';

function requestStream(): PassThrough & IncomingMessage {
  const request = new PassThrough() as PassThrough & IncomingMessage;
  request.method = 'POST';
  request.url = '/api/classes';
  return request;
}

describe('class HTTP routes', () => {
  it('rejects an oversized body once, detaches its chunk handler, and safely absorbs later stream races', async () => {
    const createClass = (): never => { throw new Error('service must not be called'); };
    const handler = createClassRoutes({
      service: { createClass } as unknown as ClassService,
      teacherContext: () => 'teacher'
    });
    const request = requestStream();
    const handling = handler(request, {} as ServerResponse);

    request.write('x'.repeat((8 * 1024) + 1));
    expect(request.listenerCount('data')).toBe(0);
    expect(request.readableFlowing).toBe(true);
    expect(() => request.emit('error', new Error('late stream error'))).not.toThrow();
    expect(() => request.emit('aborted')).not.toThrow();
    expect(() => request.end('still draining')).not.toThrow();
    await expect(handling).rejects.toThrow('REQUEST_BODY_TOO_LARGE');
  });
});
