import type { IncomingMessage, ServerResponse } from 'node:http';
import { createAuthHttpHandler, isValidCsrfToken, type PasswordVerifier, type StudentJoinPort } from './auth/http.js';
import { AuthSessions, type Clock, systemClock } from './auth/session.js';
import { ClassService } from './classes/class-service.js';
import { createClassRoutes } from './classes/http-routes.js';
import { SqliteAuthSessionRepository } from './db/auth-session-repository.js';
import { SqliteClassRosterRepository } from './db/class-roster-repository.js';
import type { SqliteDatabase } from './db/connection.js';
import { migrate } from './db/migrator.js';
import type { AuthorizedTeacherContext } from './domain/types.js';
import type { HttpRouteHandler } from './server.js';

export type ApplicationOptions = Readonly<{
  database: SqliteDatabase;
  allowedOrigin: string;
  csrfSecret: string;
  clock?: Clock;
  passwordVerifier?: PasswordVerifier;
}>;

export type Application = Readonly<{ apiHandler: HttpRouteHandler }>;

/** Thrown instead of exposing partially configured application routes. */
export class FirstRunSetupRequiredError extends Error {
  constructor() { super('FIRST_RUN_SETUP_REQUIRED'); }
}

/**
 * Wires authenticated HTTP boundaries to SQLite-backed services. It deliberately
 * refuses to create a default password: main then exposes only GET /health until
 * the loopback-only first-run setup workflow has persisted an Argon2id hash.
 */
export function createApplication(options: ApplicationOptions): Application {
  assertRuntimeSecurity(options);
  migrate(options.database);
  const authRepository = new SqliteAuthSessionRepository(options.database);
  if (authRepository.teacherPasswordHash() === undefined) throw new FirstRunSetupRequiredError();

  const sessions = new AuthSessions(authRepository, options.clock ?? systemClock);
  const classService = new ClassService({
    repository: new SqliteClassRosterRepository(options.database),
    teacherAuthorization: { assertAuthorized: (context) => assertTeacherContext(context) },
    now: () => (options.clock ?? systemClock).now().toISOString()
  });
  const studentJoin: StudentJoinPort = {
    join: (request) => {
      try {
        const outcome = classService.requestJoin(request.classId, request.displayName, request.studentNumber);
        return outcome.outcome === 'matched' ? outcome.student : undefined;
      } catch (error) {
        // The login boundary deliberately does not reveal whether an arbitrary
        // class ID exists; non-approved joins all receive the same denial.
        if (error instanceof Error && error.message === 'CLASS_NOT_FOUND') return undefined;
        throw error;
      }
    }
  };
  const authenticateTeacherMutation = (request: IncomingMessage): AuthorizedTeacherContext => {
    requireAllowedOrigin(request, options.allowedOrigin);
    const token = cookie(request, 'teacher_session');
    const teacher = sessions.authenticateTeacher(token);
    if (teacher === undefined) throw new HttpError(401, 'TEACHER_AUTH_REQUIRED');
    if (token === undefined || !isValidCsrfToken(request.headers['x-csrf-token'], token, options.csrfSecret)) {
      throw new HttpError(403, 'CSRF_REQUIRED');
    }
    return { teacherSessionId: teacher.teacherSessionId, csrfValidated: true };
  };
  const authHandler = createAuthHttpHandler({
    sessions,
    sessionRepository: authRepository,
    studentJoin,
    allowedOrigin: options.allowedOrigin,
    csrfSecret: options.csrfSecret,
    ...(options.passwordVerifier === undefined ? {} : { passwordVerifier: options.passwordVerifier })
  });
  const classHandler = createClassRoutes({ service: classService, teacherContext: authenticateTeacherMutation });

  return {
    apiHandler: async (request, response) => {
      const pathname = new URL(request.url ?? '/', 'http://lan-classroom.local').pathname;
      if (pathname.startsWith('/api/auth/')) { await authHandler(request, response); return true; }
      if (pathname === '/api/classes' || pathname.startsWith('/api/classes/') || pathname.startsWith('/api/pending-student-requests/')) {
        // Public class listing is read-only. All public join requests and every
        // mutation require the configured first-party Origin before parsing a body.
        if (request.method !== 'GET') {
          try { requireAllowedOrigin(request, options.allowedOrigin); } catch (error) { sendError(response, error); return true; }
        }
        try {
          const handled = await classHandler(request, response);
          if (!handled) sendJson(response, 404, { error: 'NOT_FOUND' });
        } catch (error) { sendError(response, error); }
        return true;
      }
      return false;
    }
  };
}

function assertRuntimeSecurity(options: ApplicationOptions): void {
  let origin: URL;
  try { origin = new URL(options.allowedOrigin); } catch { throw new Error('ALLOWED_ORIGIN_REQUIRED'); }
  if (origin.protocol !== 'http:' || origin.origin !== options.allowedOrigin || options.csrfSecret.length < 32) {
    throw new Error('RUNTIME_SECURITY_CONFIGURATION_REQUIRED');
  }
}

function assertTeacherContext(context: unknown): asserts context is AuthorizedTeacherContext {
  if (typeof context !== 'object' || context === null || (context as Partial<AuthorizedTeacherContext>).csrfValidated !== true) {
    throw new HttpError(401, 'TEACHER_AUTH_REQUIRED');
  }
}

function requireAllowedOrigin(request: IncomingMessage, allowedOrigin: string): void {
  if (request.headers.origin !== allowedOrigin) throw new HttpError(403, 'ORIGIN_REQUIRED');
}

function cookie(request: IncomingMessage, name: string): string | undefined {
  for (const part of request.headers.cookie?.split(';') ?? []) {
    const separator = part.indexOf('=');
    if (separator < 1 || part.slice(0, separator).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(separator + 1).trim()); } catch { return undefined; }
  }
  return undefined;
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

function sendError(response: ServerResponse, error: unknown): void {
  if (error instanceof HttpError) { sendJson(response, error.status, { error: error.code }); return; }
  const code = error instanceof Error ? error.message : 'INVALID_REQUEST';
  if (code === 'CLASS_NOT_FOUND' || code === 'PENDING_REQUEST_NOT_FOUND_OR_RESOLVED') { sendJson(response, 404, { error: code }); return; }
  if (code === 'REQUEST_BODY_TOO_LARGE') { sendJson(response, 413, { error: code }); return; }
  if (code === 'CLASS_DELETE_CONFIRMATION_REQUIRED' || code.startsWith('REQUEST_') || code === 'JOIN_IDENTITY_REQUIRED') { sendJson(response, 400, { error: code }); return; }
  if (code === 'PENDING_APPROVAL_STUDENT_NUMBER_CONFLICT' || code === 'ROSTER_IMPORT_STUDENT_NUMBER_CONFLICT') { sendJson(response, 409, { error: code }); return; }
  sendJson(response, 500, { error: 'CLASS_INTERNAL_ERROR' });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}
