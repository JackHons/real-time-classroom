import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ClassId, PendingStudentRequestId } from '../domain/types.js';
import { StudentJoinRateLimiter } from '../auth/http.js';
import { ClassService } from './class-service.js';
import { readBoundedJsonObject } from '../http/bounded-json.js';

const MAX_BODY_BYTES = 8 * 1024;

export type ClassRoutesDependencies = Readonly<{
  service: ClassService;
  /** Shared with /api/auth/student/join so routes cannot bypass pending limits. */
  studentJoinRateLimiter?: StudentJoinRateLimiter;
  /** Task 3 composition supplies cookie/session and CSRF validation before service authorization. */
  teacherContext: (request: IncomingMessage) => unknown;
}>;

/**
 * An opt-in route handler. It deliberately is not attached in server.ts: the
 * Task 3 composition root must inject real authentication before mounting it.
 */
export function createClassRoutes(dependencies: ClassRoutesDependencies): (request: IncomingMessage, response: ServerResponse) => Promise<boolean> {
  const studentJoinRateLimiter = dependencies.studentJoinRateLimiter ?? new StudentJoinRateLimiter();
  return async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/api/classes') {
      json(response, 200, dependencies.service.listPublicClasses());
      return true;
    }
    if (request.method === 'POST' && url.pathname === '/api/classes') {
      const teacher = dependencies.teacherContext(request);
      const body = await readJson(request);
      json(response, 201, dependencies.service.createClass(teacher, stringField(body, 'name')));
      return true;
    }
    const match = /^\/api\/classes\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'DELETE' && match?.[1] !== undefined) {
      const teacher = dependencies.teacherContext(request);
      const body = await readJson(request);
      dependencies.service.deleteClass(teacher, decodeURIComponent(match[1]) as ClassId, confirmation(body));
      json(response, 204, undefined);
      return true;
    }
    const importMatch = /^\/api\/classes\/([^/]+)\/roster\/import$/.exec(url.pathname);
    if (request.method === 'POST' && importMatch?.[1] !== undefined) {
      const teacher = dependencies.teacherContext(request);
      const body = await readJson(request);
      const result = dependencies.service.importRosterCsv(teacher, decodeURIComponent(importMatch[1]) as ClassId, stringField(body, 'csv'));
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
      const classId = decodeURIComponent(joinMatch[1]) as ClassId;
      const displayName = stringField(body, 'displayName');
      const studentNumber = stringField(body, 'studentNumber');
      const reservation = studentJoinRateLimiter.reserve(remoteAddress(request), { classId, displayName, studentNumber }, new Date());
      if (reservation === undefined) { json(response, 429, { error: 'RATE_LIMITED' }); return true; }
      let result;
      try { result = dependencies.service.requestJoin(classId, displayName, studentNumber); }
      catch (error) { reservation.release(); throw error; }
      // A pending outcome is deliberately not a student session or authorization.
      if (result.outcome === 'matched') reservation.succeed(); else reservation.fail();
      // This route may create/reuse a pending request, but it is public. Never
      // make a roster match distinguishable from a pending identity, nor expose
      // the student/pending identifiers or their timestamps here.
      json(response, 202, { outcome: 'accepted' });
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

function remoteAddress(request: IncomingMessage): string { return request.socket.remoteAddress ?? 'unknown'; }

function readJson(request: IncomingMessage): Promise<Record<string, unknown>> { return readBoundedJsonObject(request, MAX_BODY_BYTES); }

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
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}
