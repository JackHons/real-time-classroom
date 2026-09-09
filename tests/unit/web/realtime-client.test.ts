import { describe, expect, it } from 'vitest';
import { RealtimeClient, type RealtimeSocket } from '../../../apps/web/src/lib/realtime/client.js';

class FakeSocket implements RealtimeSocket {
  connected = false;
  connects = 0;
  disconnects = 0;
  private readonly handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  connect(): this { this.connects += 1; return this; }
  disconnect(): this { this.disconnects += 1; this.connected = false; return this; }
  on(event: string, callback: (...args: unknown[]) => void): this { const callbacks = this.handlers.get(event) ?? new Set(); callbacks.add(callback); this.handlers.set(event, callbacks); return this; }
  off(event: string, callback?: (...args: unknown[]) => void): this { if (callback === undefined) this.handlers.delete(event); else this.handlers.get(event)?.delete(callback); return this; }
  emit(event: string, ...args: unknown[]): void { for (const callback of this.handlers.get(event) ?? []) callback(...args); }
}

function timers(): { set: (callback: () => void, delay: number) => ReturnType<typeof globalThis.setTimeout>; clear: (timer: ReturnType<typeof globalThis.setTimeout>) => void; run: () => void } {
  const scheduled = new Map<number, () => void>(); let next = 0;
  return {
    set: (callback, delay) => { void delay; scheduled.set(++next, callback); return next as unknown as ReturnType<typeof globalThis.setTimeout>; },
    clear: (timer) => { scheduled.delete(timer as unknown as number); },
    run: () => { const candidate = [...scheduled.entries()].find(([, callback]) => callback !== undefined); expect(candidate).toBeDefined(); candidate?.[1](); }
  };
}

describe('RealtimeClient', () => {
  it('uses one jittered retry during a reconnect storm, then fully resyncs REST once connected', async () => {
    const socket = new FakeSocket(); const clock = timers(); let resyncs = 0;
    const client = new RealtimeClient({ resources: ['question'], resync: async () => { resyncs += 1; }, socketFactory: () => socket, random: () => 0, setTimer: clock.set, clearTimer: clock.clear });
    client.start(); socket.emit('disconnect'); socket.emit('connect_error'); socket.emit('disconnect');
    expect(socket.connects).toBe(1);
    clock.run(); expect(socket.connects).toBe(2);
    socket.connected = true; socket.emit('connect'); await Promise.resolve();
    expect(resyncs).toBe(1);
  });

  it('filters malformed/stale change hints and serializes REST resyncs so an older fetch cannot win later', async () => {
    const socket = new FakeSocket(); const clock = timers(); let starts = 0; let release!: () => void;
    const client = new RealtimeClient({ resources: ['question'], resync: () => new Promise<void>((resolve) => { starts += 1; release = resolve; }), socketFactory: () => socket, setTimer: clock.set, clearTimer: clock.clear });
    client.start(); socket.connected = true; socket.emit('connect');
    socket.emit('class:changed', { resourceType: 'file-task', id: 'untrusted' });
    socket.emit('class:changed', { resourceType: 'question', id: 'untrusted' }); clock.run();
    expect(starts).toBe(1); release(); await Promise.resolve(); await Promise.resolve();
    expect(starts).toBe(2);
    release(); await Promise.resolve();
  });

  it('cleans up retries and ignores socket events after logout/unmount', async () => {
    const socket = new FakeSocket(); const clock = timers(); let resyncs = 0;
    const client = new RealtimeClient({ resources: ['pending'], resync: async () => { resyncs += 1; }, socketFactory: () => socket, setTimer: clock.set, clearTimer: clock.clear });
    client.start(); socket.emit('disconnect'); client.stop();
    socket.emit('connect'); socket.emit('class:changed', { resourceType: 'pending' });
    expect(socket.disconnects).toBe(1); expect(socket.connects).toBe(1); expect(resyncs).toBe(0);
  });
});
