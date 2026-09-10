import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * A route can reject from headers alone (Origin, cookie, CSRF, or resource
 * scope).  Never leave such a request on keep-alive: a peer must not be able
 * to turn an authorization failure into an indefinitely slow body drain.
 */
export function closeUnconsumedRequestBody(request: IncomingMessage, response: ServerResponse): void {
  if (request.complete || request.destroyed || !hasDeclaredBody(request)) return;
  response.shouldKeepAlive = false;
  response.setHeader('connection', 'close');

  // Do not drain attacker-controlled bytes into user space.  Ending the
  // socket after the response is queued preserves the documented status/body
  // for normal clients, while its FIN prevents keep-alive and makes a slow
  // sender release the request without waiting for its declared length.
  request.pause();
  response.once('finish', () => {
    if (!request.socket.destroyed) request.socket.end();
  });
}

function hasDeclaredBody(request: IncomingMessage): boolean {
  if (request.headers['transfer-encoding'] !== undefined) return true;
  const length = request.headers['content-length'];
  return typeof length === 'string' && /^(?:[1-9][0-9]*)$/.test(length);
}
