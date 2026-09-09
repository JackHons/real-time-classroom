import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../../apps/server/src/server.js';

describe('Windows explicit LAN bindings', () => {
  let running: RunningServer | undefined;
  afterEach(async () => { await running?.close(); });

  it('shares one dynamically selected port between loopback and a second explicit address', async () => {
    running = await startServer({ host: '127.0.0.2', hosts: ['127.0.0.1', '127.0.0.2'], port: 0 });
    expect(running.host).toBe('127.0.0.2');
    expect(running.hosts).toEqual(['127.0.0.1', '127.0.0.2']);
    expect((await fetch(`http://127.0.0.1:${running.port}/health`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.2:${running.port}/health`)).status).toBe(200);
  });
});
