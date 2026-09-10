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

  it('applies browser isolation headers to every response at the HTTP boundary', async () => {
    running = await startServer({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`http://${running.host}:${running.port}/health`);
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('content-security-policy')).not.toContain('unsafe-eval');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('permissions-policy')).toContain('camera=()');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('reports a fail-closed bootstrap as explicitly not ready', async () => {
    running = await startServer({ host: '127.0.0.1', port: 0, health: { status: 503, state: 'not_ready', reason: 'UPLOAD_STORAGE_NOT_READY' } });
    const response = await fetch(`http://${running.host}:${running.port}/health`);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: 'not_ready',
      service: 'lan-classroom-platform',
      reason: 'UPLOAD_STORAGE_NOT_READY'
    });
  });
});
