import { io } from 'socket.io-client';

/**
 * The gateway intentionally sends only invalidation hints.  Never add entity
 * fields here: the REST endpoint remains the single source of UI state.
 */
export type RealtimeResource = 'class' | 'roster' | 'question' | 'file-task';
export type RealtimeStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';
export type ChangeHint = Readonly<{ resourceType: RealtimeResource }>;
type Timer = ReturnType<typeof globalThis.setTimeout>;

export interface RealtimeSocket {
  connected: boolean;
  connect(): RealtimeSocket;
  disconnect(): RealtimeSocket;
  on(event: string, callback: (...args: unknown[]) => void): RealtimeSocket;
  off(event: string, callback?: (...args: unknown[]) => void): RealtimeSocket;
}

export type RealtimeOptions = Readonly<{
  resources: readonly RealtimeResource[];
  /** Performs a complete, cookie-authenticated REST resync. */
  resync: () => Promise<void>;
  onStatus?: (status: RealtimeStatus) => void;
  socketFactory?: () => RealtimeSocket;
  random?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => Timer;
  clearTimer?: (timer: Timer) => void;
}>;

const CHANGE_EVENT = 'class:changed';
const BASE_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;
const EVENT_DEBOUNCE_MS = 350;

function browserSocket(): RealtimeSocket {
  // Same-origin cookies authenticate the handshake. The server derives the
  // class/actor scope; the browser never sends an actor, class, or token.
  return io({
    path: '/socket.io',
    withCredentials: true,
    reconnection: false,
    transports: ['websocket', 'polling']
  }) as unknown as RealtimeSocket;
}

function changeHint(value: unknown, accepted: ReadonlySet<RealtimeResource>): ChangeHint | undefined {
  if (typeof value !== 'object' || value === null || !('resourceType' in value)) return undefined;
  const resourceType = value.resourceType;
  return typeof resourceType === 'string' && accepted.has(resourceType as RealtimeResource)
    ? { resourceType: resourceType as RealtimeResource }
    : undefined;
}

/**
 * Owns one page's optional realtime transport. Repeated hints are debounced,
 * disconnect retries have jitter, and every accepted hint results only in a
 * REST resync.  It deliberately exposes no event payload to the UI.
 */
export class RealtimeClient {
  private readonly accepted: ReadonlySet<RealtimeResource>;
  private readonly socket: RealtimeSocket;
  private readonly random: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => Timer;
  private readonly clearTimer: (timer: Timer) => void;
  private retryTimer: Timer | undefined;
  private changeTimer: Timer | undefined;
  private running = false;
  private live = false;
  private retryAttempt = 0;
  private resyncing: Promise<void> | undefined;
  private resyncQueued = false;
  private generation = 0;

  constructor(private readonly options: RealtimeOptions) {
    this.accepted = new Set(options.resources);
    this.socket = (options.socketFactory ?? browserSocket)();
    this.random = options.random ?? Math.random;
    this.setTimer = options.setTimer ?? globalThis.setTimeout;
    this.clearTimer = options.clearTimer ?? globalThis.clearTimeout;
    this.socket.on('connect', this.connected);
    this.socket.on('disconnect', this.disconnected);
    this.socket.on('connect_error', this.connectionFailed);
    this.socket.on(CHANGE_EVENT, this.changed);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.options.onStatus?.('connecting');
    this.socket.connect();
  }

  stop(): void {
    if (!this.running && this.generation > 0) return;
    this.running = false;
    this.live = false;
    this.generation += 1;
    if (this.retryTimer !== undefined) this.clearTimer(this.retryTimer);
    if (this.changeTimer !== undefined) this.clearTimer(this.changeTimer);
    this.retryTimer = undefined;
    this.changeTimer = undefined;
    this.resyncQueued = false;
    this.socket.disconnect();
  }

  isLive(): boolean { return this.running && this.live && this.socket.connected; }

  private readonly connected = (): void => {
    if (!this.running) return;
    this.live = true;
    this.retryAttempt = 0;
    if (this.retryTimer !== undefined) this.clearTimer(this.retryTimer);
    this.retryTimer = undefined;
    this.options.onStatus?.('live');
    // A reconnect never trusts missed socket history; it re-reads REST.
    void this.requestResync();
  };

  private readonly disconnected = (): void => {
    if (!this.running) return;
    this.live = false;
    this.options.onStatus?.('offline');
    this.scheduleRetry();
  };

  private readonly connectionFailed = (): void => {
    if (!this.running) return;
    this.live = false;
    this.options.onStatus?.('offline');
    this.scheduleRetry();
  };

  private readonly changed = (value: unknown): void => {
    // Parse only the resource discriminator. IDs, timestamps and every other
    // field are untrusted and never make their way into application state.
    if (!this.running || changeHint(value, this.accepted) === undefined) return;
    if (this.changeTimer !== undefined) return;
    this.changeTimer = this.setTimer(() => {
      this.changeTimer = undefined;
      void this.requestResync();
    }, EVENT_DEBOUNCE_MS);
  };

  private scheduleRetry(): void {
    if (!this.running || this.retryTimer !== undefined) return;
    const exponent = Math.min(this.retryAttempt++, 5);
    const cap = Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** exponent);
    // Full jitter prevents an entire classroom from reconnecting together.
    const delay = Math.max(250, Math.floor(cap * (0.5 + this.random() * 0.5)));
    this.options.onStatus?.('reconnecting');
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = undefined;
      if (this.running) this.socket.connect();
    }, delay);
  }

  private async requestResync(): Promise<void> {
    if (!this.running) return;
    if (this.resyncing !== undefined) { this.resyncQueued = true; return this.resyncing; }
    const currentGeneration = this.generation;
    this.resyncing = (async () => {
      do {
        this.resyncQueued = false;
        try {
          await this.options.resync();
        } catch {
          // REST polling remains the fallback; a failed hint must not make the
          // socket reconnect loop or overwrite a usable screen.
        }
      } while (this.running && currentGeneration === this.generation && this.resyncQueued);
    })();
    try { await this.resyncing; }
    finally { this.resyncing = undefined; }
  }
}

export const realtimeEventContract = Object.freeze({
  event: CHANGE_EVENT,
  payload: '{ resourceType: "class" | "roster" | "question" | "file-task" }'
});
