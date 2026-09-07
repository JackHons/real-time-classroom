import { PassThrough } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { readBoundedJsonObject } from '../../../apps/server/src/http/bounded-json.js';

function request(): PassThrough & IncomingMessage { return new PassThrough() as PassThrough & IncomingMessage; }

describe('bounded JSON HTTP reader', () => {
  it('rejects an oversized stream once while safely draining terminal races', async () => {
    const input = request();
    const reading = readBoundedJsonObject(input, 16);
    input.write(Buffer.alloc(17));
    await expect(reading).rejects.toThrow('REQUEST_BODY_TOO_LARGE');
    // These may race with the rejected chunk on a real socket. They must not
    // throw or change the already-settled result while the stream is drained.
    expect(() => input.emit('error', new Error('socket failure'))).not.toThrow();
    expect(() => input.emit('aborted')).not.toThrow();
    input.end();
  });
});
