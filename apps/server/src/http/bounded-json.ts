import { Buffer } from 'node:buffer';
import type { IncomingMessage } from 'node:http';

/**
 * Reads an object-shaped JSON request body without retaining more than the
 * caller's explicit byte budget.  Route handlers should use this even for
 * commands with no payload so a client cannot smuggle an unlimited stream
 * through a mutation endpoint.
 */
export function readBoundedJsonObject(request: IncomingMessage, maximumBytes: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;

    const removeListeners = (): void => {
      request.removeListener('data', onData);
      request.removeListener('end', onEnd);
      request.removeListener('error', onError);
      request.removeListener('aborted', onAborted);
      request.removeListener('close', finishDraining);
    };
    const rejectOnce = (error: Error): void => {
      if (settled) return;
      settled = true;
      request.removeListener('data', onData);
      request.removeListener('end', onEnd);
      // Keep terminal error/abort listeners while draining. A stream failure
      // can race with the over-limit chunk; these handlers make every later
      // terminal event a harmless no-op instead of an unhandled EventEmitter
      // error. They are removed at end/close below.
      request.once('end', finishDraining);
      request.once('close', finishDraining);
      // Drain the remaining bytes so a rejected keep-alive request cannot
      // retain this route's buffers or stall the connection.
      request.resume();
      reject(error);
    };
    const resolveOnce = (body: Record<string, unknown>): void => {
      if (settled) return;
      settled = true;
      removeListeners();
      resolve(body);
    };
    const onData = (chunk: Buffer | string): void => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maximumBytes) {
        rejectOnce(new Error('REQUEST_BODY_TOO_LARGE'));
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = (): void => {
      if (settled) return;
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('REQUEST_BODY_OBJECT_REQUIRED');
        resolveOnce(value as Record<string, unknown>);
      } catch (error) {
        rejectOnce(error instanceof Error ? error : new Error('REQUEST_BODY_INVALID'));
      }
    };
    const onError = (error: Error): void => rejectOnce(error);
    const onAborted = (): void => rejectOnce(new Error('REQUEST_ABORTED'));
    const finishDraining = (): void => removeListeners();

    request.on('data', onData);
    request.once('end', onEnd);
    request.on('error', onError);
    request.on('aborted', onAborted);
  });
}
