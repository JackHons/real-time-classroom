import { PassThrough } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { readBoundedJsonObject } from '../../../apps/server/src/http/bounded-json.js';

function stream(): PassThrough & IncomingMessage { return new PassThrough() as PassThrough & IncomingMessage; }

describe('bounded JSON body reader', () => {
  it('destroys an idle slow-body stream instead of retaining the connection', async () => {
    const request = stream();
    const reading = readBoundedJsonObject(request, 1024, { idleMs: 10, absoluteMs: 30 });
    await expect(reading).rejects.toThrow('REQUEST_BODY_IDLE_TIMEOUT');
    expect(request.destroyed).toBe(true);
  });

  it('enforces the absolute deadline even while a peer drips bytes', async () => {
    const request = stream();
    const reading = readBoundedJsonObject(request, 1024, { idleMs: 15, absoluteMs: 20 });
    request.write('{');
    await delay(8);
    request.write('"a"');
    await expect(reading).rejects.toThrow('REQUEST_BODY_DEADLINE_EXCEEDED');
    expect(request.destroyed).toBe(true);
  });
});
