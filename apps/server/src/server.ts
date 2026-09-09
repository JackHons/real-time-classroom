import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse
} from 'node:http';
import { attachRealtimeGateway, type RealtimeGateway, type RealtimeGatewayOptions } from './realtime/gateway.js';

export type HttpRequestListener = (request: IncomingMessage, response: ServerResponse) => void;
export type HttpRouteHandler = (request: IncomingMessage, response: ServerResponse) => boolean | Promise<boolean>;

export type ServerOptions = Readonly<{
  host?: string;
  port?: number;
  /** Bootstrap may expose a health-only, explicitly non-ready host. */
  health?: Readonly<{ status: 200 | 503; state: 'ready' | 'not_ready'; reason?: string }>;
  /** API routes share this host and take precedence over the SvelteKit handler. */
  apiHandler?: HttpRouteHandler;
  webHandler?: HttpRequestListener;
  /** Socket.IO is attached to this same HTTP server; it has no mutation routes. */
  realtime?: RealtimeGatewayOptions;
  onRealtimeGateway?: (gateway: RealtimeGateway) => void;
}>;

export type RunningServer = Readonly<{
  host: string;
  port: number;
  close: () => Promise<void>;
}>;

/**
 * The one Node HTTP host used by the application. Bootstrap attaches a built
 * SvelteKit handler; later tasks add REST routes and the Socket.IO gateway here.
 */
export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 4173;
  const server = createServer((request, response) => { void dispatch(request, response, options); });
  const realtime = options.realtime === undefined ? undefined : attachRealtimeGateway(server, options.realtime);
  if (realtime !== undefined) options.onRealtimeGateway?.(realtime);

  await listen(server, host, port);
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await realtime?.close();
    await close(server);
    throw new Error('The HTTP server did not expose a TCP address.');
  }

  return {
    host,
    port: address.port,
    close: async () => { await realtime?.close(); await close(server); }
  };
}

async function dispatch(request: IncomingMessage, response: ServerResponse, options: ServerOptions): Promise<void> {
  try {
    if (request.method === 'GET' && request.url === '/health') {
      const health = options.health ?? { status: 200, state: 'ready' };
      response.writeHead(health.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ status: health.state === 'ready' ? 'ok' : 'not_ready', service: 'lan-classroom-platform', ...(health.reason === undefined ? {} : { reason: health.reason }) }));
      return;
    }

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
