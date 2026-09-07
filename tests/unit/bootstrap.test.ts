import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../../apps/server/src/server.js';

let running: RunningServer | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

describe('bootstrap host', () => {
  it('exports a startServer entry point', () => {
    expect(startServer).toBeTypeOf('function');
  });

  it('serves a local health response', async () => {
    running = await startServer({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`http://${running.host}:${running.port}/health`);

    await expect(response.json()).resolves.toEqual({
      status: 'ok',
      service: 'lan-classroom-platform'
    });
  });
});
