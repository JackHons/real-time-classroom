import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ClassId, PendingStudentRequestId } from '../domain/types.js';
import { ClassService } from './class-service.js';

export type ClassRoutesDependencies = Readonly<{
  service: ClassService;
  /** Task 3 composition supplies cookie/session and CSRF validation before service authorization. */
  teacherContext: (request: IncomingMessage) => unknown;
}>;

/**
 * An opt-in route handler. It deliberately is not attached in server.ts: the
 * Task 3 composition root must inject real authentication before mounting it.
 */
export function createClassRoutes(dependencies: ClassRoutesDependencies): (request: IncomingMessage, response: ServerResponse) => Promise<boolean> {
  return async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/api/classes') {
      json(response, 200, dependencies.service.listPublicClasses());
      return true;
    }
    if (request.method === 'POST' && url.pathname === '/api/classes') {
      const body = await readJson(request);
      json(response, 201, dependencies.service.createClass(dependencies.teacherContext(request), stringField(body, 'name')));
      return true;
    }
    const match = /^\/api\/classes\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'DELETE' && match?.[1] !== undefined) {
      const body = await readJson(request);
      dependencies.service.deleteClass(dependencies.teacherContext(request), decodeURIComponent(match[1]) as ClassId, confirmation(body));
      json(response, 204, undefined);
      return true;
    }
    const importMatch = /^\/api\/classes\/([^/]+)\/roster\/import$/.exec(url.pathname);
    if (request.method === 'POST' && importMatch?.[1] !== undefined) {
      const body = await readJson(request);
      const result = dependencies.service.importRosterCsv(dependencies.teacherContext(request), decodeURIComponent(importMatch[1]) as ClassId, stringField(body, 'csv'));
      json(response, result.issues.length === 0 ? 200 : 422, result);
      return true;
    }
    const previewMatch = /^\/api\/classes\/([^/]+)\/roster\/preview$/.exec(url.pathname);
    if (request.method === 'POST' && previewMatch?.[1] !== undefined) {
      const body = await readJson(request);
      json(response, 200, dependencies.service.previewRosterCsv(stringField(body, 'csv')));
      return true;
    }
    const joinMatch = /^\/api\/classes\/([^/]+)\/join$/.exec(url.pathname);
    if (request.method === 'POST' && joinMatch?.[1] !== undefined) {
      const body = await readJson(request);
      const result = dependencies.service.requestJoin(decodeURIComponent(joinMatch[1]) as ClassId, stringField(body, 'displayName'), stringField(body, 'studentNumber'));
      // A pending outcome is deliberately not a student session or authorization.
      json(response, result.outcome === 'matched' ? 200 : 202, result);
      return true;
    }
    const approveMatch = /^\/api\/pending-student-requests\/([^/]+)\/approve$/.exec(url.pathname);
    if (request.method === 'POST' && approveMatch?.[1] !== undefined) {
      json(response, 201, dependencies.service.approvePendingRequest(dependencies.teacherContext(request), decodeURIComponent(approveMatch[1]) as PendingStudentRequestId));
      return true;
    }
    return false;
  };
}

function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => { raw += chunk; });
    request.on('end', () => {
      try {
        const parsed: unknown = raw.length === 0 ? {} : JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('REQUEST_BODY_OBJECT_REQUIRED');
        resolve(parsed as Record<string, unknown>);
      } catch (error) { reject(error); }
    });
    request.on('error', reject);
  });
}

function stringField(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string') throw new Error(`REQUEST_${field.toUpperCase()}_REQUIRED`);
  return value;
}

function confirmation(body: Record<string, unknown>): Readonly<{ confirmed: boolean; impactAcknowledged: boolean }> {
  return { confirmed: body.confirmed === true, impactAcknowledged: body.impactAcknowledged === true };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  if (status === 204) { response.writeHead(status); response.end(); return; }
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}
