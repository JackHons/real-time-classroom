import { PassThrough } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readBoundedJsonObject } from '../../../apps/server/src/http/bounded-json.js';

function stream(): PassThrough & IncomingMessage { return new PassThrough() as PassThrough & IncomingMessage; }

afterEach(() => { vi.useRealTimers(); });

describe('bounded JSON body reader', () => {
  it('destroys an idle slow-body stream instead of retaining the connection', async () => {
    vi.useFakeTimers();
    const request = stream();
    const reading = readBoundedJsonObject(request, 1024, { idleMs: 10, absoluteMs: 30 });
    const rejected = expect(reading).rejects.toThrow('REQUEST_BODY_IDLE_TIMEOUT');
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    expect(request.destroyed).toBe(true);
  });

  it('enforces the absolute deadline even while a peer drips bytes', async () => {
    vi.useFakeTimers();
    const request = stream();
    const reading = readBoundedJsonObject(request, 1024, { idleMs: 15, absoluteMs: 20 });
    const rejected = expect(reading).rejects.toThrow('REQUEST_BODY_DEADLINE_EXCEEDED');
    request.write('{');
    await vi.advanceTimersByTimeAsync(8);
    request.write('"a"');
    await vi.advanceTimersByTimeAsync(12);
    await rejected;
    expect(request.destroyed).toBe(true);
  });
});
