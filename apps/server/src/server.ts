import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse
} from 'node:http';

export type HttpRequestListener = (request: IncomingMessage, response: ServerResponse) => void;
export type HttpRouteHandler = (request: IncomingMessage, response: ServerResponse) => boolean | Promise<boolean>;

export type ServerOptions = Readonly<{
  host?: string;
  port?: number;
  /** API routes share this host and take precedence over the SvelteKit handler. */
  apiHandler?: HttpRouteHandler;
  webHandler?: HttpRequestListener;
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

  await listen(server, host, port);
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await close(server);
    throw new Error('The HTTP server did not expose a TCP address.');
  }

  return {
    host,
    port: address.port,
    close: () => close(server)
  };
}

async function dispatch(request: IncomingMessage, response: ServerResponse, options: ServerOptions): Promise<void> {
  try {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ status: 'ok', service: 'lan-classroom-platform' }));
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
      if (error === undefined) {
        resolve();
        return;
      }
      reject(error);
    });
  });
}
