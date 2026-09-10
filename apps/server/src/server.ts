import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse
} from 'node:http';
import { setTimeout } from 'node:timers';
import { attachRealtimeGateway, type RealtimeGateway, type RealtimeGatewayOptions } from './realtime/gateway.js';

// These are assigned on every explicit address binding. JSON commands enforce
// their own 30-second body deadline; the server-level request timeout remains
// long enough for the separately bounded streamed-upload route.
const HEADERS_TIMEOUT_MS = 30_000;
const KEEP_ALIVE_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 5 * 60_000;
const MAX_CONNECTIONS_PER_ADDRESS = 256;

export type HttpRequestListener = (request: IncomingMessage, response: ServerResponse) => void;
export type HttpRouteHandler = (request: IncomingMessage, response: ServerResponse) => boolean | Promise<boolean>;

export type ServerOptions = Readonly<{
  host?: string;
  /** Explicit bindings only.  The Windows launcher supplies private IPv4 plus loopback. */
  hosts?: readonly string[];
  port?: number;
  /** Bootstrap may expose a health-only, explicitly non-ready host. */
  health?: Readonly<{ status: 200 | 503; state: 'ready' | 'not_ready'; reason?: string; version?: string; schemaVersion?: string; upgradeReady?: boolean }>;
  /** Pre-application first-run surface. It must self-authorize every request. */
  bootstrapHandler?: HttpRouteHandler;
  /** API routes share this host and take precedence over the SvelteKit handler. */
  apiHandler?: HttpRouteHandler;
  webHandler?: HttpRequestListener;
  /** Socket.IO is attached to this same HTTP server; it has no mutation routes. */
  realtime?: RealtimeGatewayOptions;
  onRealtimeGateway?: (gateway: RealtimeGateway) => void;
  /** Local launcher control surface; never exposed through application routes. */
  shutdownToken?: string;
  onShutdown?: () => void;
}>;

export type RunningServer = Readonly<{
  host: string;
  hosts: readonly string[];
  port: number;
  close: () => Promise<void>;
}>;

/**
 * The one Node HTTP host used by the application. Bootstrap attaches a built
 * SvelteKit handler; later tasks add REST routes and the Socket.IO gateway here.
 */
export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const host = options.host ?? options.hosts?.[0] ?? '127.0.0.1';
  const hosts = [...new Set(options.hosts ?? [host])];
  const port = options.port ?? 4173;
  const servers = hosts.map(() => {
    const server = createServer((request, response) => { void dispatch(request, response, options); });
    // Node applies maxConnections independently to each Server instance, which
    // is precisely our explicit-address admission boundary.
    server.headersTimeout = HEADERS_TIMEOUT_MS;
    server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
    server.requestTimeout = REQUEST_TIMEOUT_MS;
    server.maxConnections = MAX_CONNECTIONS_PER_ADDRESS;
    return server;
  });
  const realtime = options.realtime === undefined ? [] : servers.map((server) => attachRealtimeGateway(server, options.realtime as RealtimeGatewayOptions));
  for (const gateway of realtime) options.onRealtimeGateway?.(gateway);

  try {
    // A port selected by the launcher is shared only by disjoint local addresses.
    // Bind loopback first so a partial failure does not expose the LAN listener.
    let listeningPort = port;
    for (let index = 0; index < servers.length; index += 1) {
      await listen(servers[index] as HttpServer, hosts[index] as string, listeningPort);
      // Port zero means the kernel chose a port for the first explicit binding;
      // subsequent bindings must use that same port.
      if (index === 0 && port === 0) {
        const firstAddress = servers[0]?.address();
        if (firstAddress === null || firstAddress === undefined || typeof firstAddress === 'string') throw new Error('The HTTP server did not expose a TCP address.');
        listeningPort = firstAddress.port;
      }
    }
  } catch (error) {
    await Promise.all(realtime.map((gateway) => gateway.close()));
    await Promise.all(servers.map((server) => close(server)));
    throw error;
  }
  const address = servers[0]?.address();
  if (address === null || address === undefined || typeof address === 'string') {
    await Promise.all(realtime.map((gateway) => gateway.close()));
    await Promise.all(servers.map((server) => close(server)));
    throw new Error('The HTTP server did not expose a TCP address.');
  }

  return {
    host,
    hosts,
    port: address.port,
    close: async () => { await Promise.all(realtime.map((gateway) => gateway.close())); await Promise.all(servers.map((server) => close(server))); }
  };
}

async function dispatch(request: IncomingMessage, response: ServerResponse, options: ServerOptions): Promise<void> {
  try {
    if (request.method === 'POST' && request.url === '/internal/shutdown') {
      const peer = request.socket.remoteAddress;
      const host = request.headers.host;
      const port = request.socket.localPort;
      const direct = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
      const literalHost = host === `127.0.0.1:${port}` || host === `[::1]:${port}`;
      const origin = request.headers.origin;
      const permittedOrigin = origin === undefined || origin === `http://${host}`;
      const proxied = request.headers.forwarded !== undefined || request.headers.via !== undefined || request.headers['x-forwarded-for'] !== undefined || request.headers['x-forwarded-host'] !== undefined || request.headers['x-forwarded-proto'] !== undefined || request.headers['x-real-ip'] !== undefined;
      if (!direct || !literalHost || !permittedOrigin || proxied || request.headers['x-lan-shutdown-token'] !== options.shutdownToken) { response.writeHead(403, { 'cache-control': 'no-store' }); response.end(); return; }
      response.writeHead(202, { 'cache-control': 'no-store' }); response.end();
      setTimeout(() => options.onShutdown?.(), 0).unref(); return;
    }
    if (request.method === 'GET' && request.url === '/health') {
      const health = options.health ?? { status: 200, state: 'ready' };
      response.writeHead(health.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ status: health.state === 'ready' ? 'ok' : 'not_ready', service: 'lan-classroom-platform', ...(health.reason === undefined ? {} : { reason: health.reason }), ...(health.version === undefined ? {} : { version: health.version }), ...(health.schemaVersion === undefined ? {} : { schemaVersion: health.schemaVersion }), ...(health.upgradeReady === undefined ? {} : { upgradeReady: health.upgradeReady }) }));
      return;
    }

    if (options.bootstrapHandler !== undefined && await options.bootstrapHandler(request, response)) return;
    if (options.apiHandler !== undefined && await options.apiHandler(request, response)) return;

    if (options.webHandler !== undefined) {
      options.webHandler(request, response);
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: 'NOT_IMPLEMENTED' }));
  } catch {
    if (!response.headersSent) {
      response.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ error: 'INTERNAL_ERROR' }));
    } else if (!response.writableEnded) {
      response.end();
    }
  }
}

function listen(server: HttpServer, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function close(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      // Socket.IO closes its Engine.IO transport first. Depending on the
      // transport mix, Node may already consider the shared server closed.
      if (error === undefined || (error as { code?: unknown }).code === 'ERR_SERVER_NOT_RUNNING') {
        resolve();
        return;
      }
      reject(error);
    });
  });
}
