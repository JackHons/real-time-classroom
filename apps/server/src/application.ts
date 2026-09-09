import type { IncomingMessage, ServerResponse } from 'node:http';
import { createAuthHttpHandler, isValidCsrfToken, StudentJoinRateLimiter, type PasswordVerifier, type StudentJoinPort } from './auth/http.js';
import { AuthSessions, type Clock, systemClock } from './auth/session.js';
import { createActivityRoutes } from './activities/http-routes.js';
import { ClassService } from './classes/class-service.js';
import { createClassRoutes } from './classes/http-routes.js';
import { SqliteAuthSessionRepository } from './db/auth-session-repository.js';
import { SqliteClassRosterRepository } from './db/class-roster-repository.js';
import type { SqliteDatabase } from './db/connection.js';
import { SqliteFileSubmissionTaskRepository } from './db/file-submission-task-repository.js';
import { SqliteLiveQuestionRepository } from './db/live-question-repository.js';
import { migrate } from './db/migrator.js';
import { SqliteQuestionBankRepository } from './db/question-bank-repository.js';
import { SqliteDomainRepository } from './db/sqlite-repositories.js';
import { SqliteUploadPipelineRepository } from './db/upload-pipeline-repository.js';
import type { AuthorizedStudentContext, AuthorizedTeacherContext } from './domain/types.js';
import { createFileTaskRoutes } from './file-tasks/http-routes.js';
import { FileTaskService } from './file-tasks/service.js';
import { createQuestionBankRoutes } from './questions/bank/http-routes.js';
import { QuestionBankService } from './questions/bank/service.js';
import { createLiveQuestionRoutes } from './questions/live/http-routes.js';
import { LiveQuestionService } from './questions/live/live-question-service.js';
import type { HttpRouteHandler } from './server.js';
import { RealtimeNotificationBus, type RealtimeGatewayOptions } from './realtime/gateway.js';
import { createUploadRoutes } from './uploads/http-routes.js';
import { UploadPipeline } from './uploads/pipeline.js';
import { UploadStorage, type UploadStorageOptions } from './uploads/storage.js';

export type ApplicationOptions = Readonly<{
  database: SqliteDatabase;
  allowedOrigin: string;
  csrfSecret: string;
  clock?: Clock;
  passwordVerifier?: PasswordVerifier;
  /** Allows focused tests and composition to set shared public join budgets. */
  studentJoinRateLimiter?: StudentJoinRateLimiter;
  /** Private, runtime-owned directory.  It is never taken from an HTTP request. */
  uploadStorageRoot?: string;
  /** Test composition may inject the same private storage across a restart. */
  uploadStorage?: UploadStorage;
  /** Deployment reserve; production configuration may only raise the safe default. */
  uploadStorageOptions?: UploadStorageOptions;
  /** Focused tests may shorten these; production uses the conservative route defaults. */
  uploadIdleTimeoutMs?: number;
  uploadAbsoluteRequestTimeoutMs?: number;
  /** Focused server tests may shorten realtime liveness checks. */
  realtimeSessionCheckMs?: number;
  realtimeHeartbeatMs?: number;
}>;

export type Application = Readonly<{
  apiHandler: HttpRouteHandler;
  reconcileUploads: () => Promise<Readonly<{ recovered: number; cleaned: number; metadataMissing: number; cleanupFailed: number }>>;
  realtime: RealtimeGatewayOptions;
  realtimeNotifications: RealtimeNotificationBus;
}>;

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

  const clock = options.clock ?? systemClock;
  const sessions = new AuthSessions(authRepository, clock);
  const realtimeNotifications = new RealtimeNotificationBus();
  const studentJoinRateLimiter = options.studentJoinRateLimiter ?? new StudentJoinRateLimiter();
  const rosterRepository = new SqliteClassRosterRepository(options.database);
  const classService = new ClassService({
    repository: rosterRepository,
    teacherAuthorization: { assertAuthorized: (context) => assertTeacherContext(context) },
    now: () => clock.now().toISOString(),
    notify: (event) => realtimeNotifications.publish(event),
    onClassDeleted: (classId) => realtimeNotifications.evictClass(classId)
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
  const authenticateTeacher = (request: IncomingMessage): AuthorizedTeacherContext => {
    if (request.method !== 'GET') requireAllowedOrigin(request, options.allowedOrigin);
    const token = cookie(request, 'teacher_session');
    if (token === undefined) throw new HttpError(401, 'TEACHER_AUTH_REQUIRED');
    if (request.method !== 'GET' && !isValidCsrfToken(request.headers['x-csrf-token'], token, options.csrfSecret)) {
      throw new HttpError(403, 'CSRF_REQUIRED');
    }
    // authenticateTeacher refreshes idle expiry. Validate every non-touching
    // request property first so a rejected CSRF request cannot keep a session alive.
    const teacher = sessions.authenticateTeacher(token);
    if (teacher === undefined) throw new HttpError(401, 'TEACHER_AUTH_REQUIRED');
    // Read routes are authorized too; only mutation routes claim CSRF validation.
    return { teacherSessionId: teacher.teacherSessionId, csrfValidated: true };
  };
  const authenticateStudent = (request: IncomingMessage) => {
    if (request.method !== 'GET') requireAllowedOrigin(request, options.allowedOrigin);
    const token = cookie(request, 'student_session');
    if (token === undefined) throw new HttpError(401, 'STUDENT_AUTH_REQUIRED');
    if (request.method !== 'GET' && !isValidCsrfToken(request.headers['x-csrf-token'], token, options.csrfSecret)) {
      throw new HttpError(403, 'CSRF_REQUIRED');
    }
    const student = sessions.authenticateStudent(token);
    if (student === undefined) throw new HttpError(401, 'STUDENT_AUTH_REQUIRED');
    return { studentSessionId: student.studentSessionId, studentId: student.studentId, classId: student.classId, csrfValidated: true as const };
  };
  const authHandler = createAuthHttpHandler({
    sessions,
    sessionRepository: authRepository,
    studentJoin,
    allowedOrigin: options.allowedOrigin,
    csrfSecret: options.csrfSecret,
    studentJoinRateLimiter,
    ...(options.passwordVerifier === undefined ? {} : { passwordVerifier: options.passwordVerifier })
  });
  const classHandler = createClassRoutes({ service: classService, teacherContext: authenticateTeacher, studentJoinRateLimiter });
  const domainRepository = new SqliteDomainRepository(options.database, () => clock.now().toISOString());
  const questionBankHandler = createQuestionBankRoutes({
    service: new QuestionBankService({
      repository: new SqliteQuestionBankRepository(options.database, () => clock.now().toISOString()),
      teacherAuthorization: { assertAuthorized: (context) => assertTeacherContext(context) },
      classExists: (classId) => rosterRepository.classExists(classId),
      notify: (event) => {
        if (event.classId === undefined) realtimeNotifications.publishTeacher({ resourceType: 'question', id: event.id, event: event.event });
        else realtimeNotifications.publish({ classId: event.classId, resourceType: 'question', id: event.id, event: event.event, audience: 'teacher' });
      }
    }),
    teacherContext: authenticateTeacher
  });
  const liveQuestionHandler = createLiveQuestionRoutes({
    service: new LiveQuestionService({
      repository: new SqliteLiveQuestionRepository(options.database, domainRepository),
      teacherAuthorization: { assertAuthorized: (context) => assertTeacherContext(context) },
      studentAuthorization: { assertAuthorized: (context) => assertStudentContext(context) },
      notify: (event) => realtimeNotifications.publish({ classId: event.classId, resourceType: 'question', id: event.questionId, event: event.type, audience: event.type === 'answer_updated' ? 'teacher' : 'all' })
    }),
    teacherContext: authenticateTeacher,
    studentContext: authenticateStudent
  });
  const fileRepository = new SqliteFileSubmissionTaskRepository(options.database, () => clock.now().toISOString());
  const storage = options.uploadStorage ?? new UploadStorage(options.uploadStorageRoot ?? 'runtime-data/uploads', options.uploadStorageOptions);
  const fileTaskService = new FileTaskService({
    repository: fileRepository,
    storage,
    teacherAuthorization: { assertAuthorized: (context) => assertTeacherContext(context) },
    studentAuthorization: { assertAuthorized: (context) => assertStudentContext(context) },
    classExists: (classId) => rosterRepository.classExists(classId),
    now: () => clock.now(),
    notify: (event) => realtimeNotifications.publish(event)
  });
  const fileTaskHandler = createFileTaskRoutes({ service: fileTaskService, repository: fileRepository, teacherContext: authenticateTeacher, studentContext: authenticateStudent });
  const uploadPipeline = new UploadPipeline({ repository: new SqliteUploadPipelineRepository(options.database, () => clock.now().toISOString()), storage, now: () => clock.now(), onTaskClosed: (task) => realtimeNotifications.publish({ classId: task.classId, resourceType: 'file-task', id: task.taskId, event: 'filetask_closed', audience: 'all' }) });
  const uploadHandler = createUploadRoutes({ pipeline: uploadPipeline, repository: fileRepository, storage, studentContext: authenticateStudent, teacherContext: authenticateTeacher, notify: (event) => realtimeNotifications.publish(event), ...(options.uploadIdleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.uploadIdleTimeoutMs }), ...(options.uploadAbsoluteRequestTimeoutMs === undefined ? {} : { absoluteRequestTimeoutMs: options.uploadAbsoluteRequestTimeoutMs }) });
  const activityHandler = createActivityRoutes({ database: options.database, teacherContext: authenticateTeacher, studentContext: authenticateStudent });
  let uploadsReady = false;

  return {
    realtime: {
      allowedOrigin: options.allowedOrigin,
      authenticateTeacher: (token) => sessions.authenticateTeacher(token),
      authenticateStudent: (token) => sessions.authenticateStudent(token),
      // This deployment has one shared teacher principal. Therefore every
      // existing class is authorized for an authenticated teacher; retaining
      // the explicit predicate makes a future per-teacher model fail closed.
      canTeacherAccessClass: (_teacher, classId) => rosterRepository.classExists(classId),
      ...(options.realtimeSessionCheckMs === undefined ? {} : { sessionCheckMs: options.realtimeSessionCheckMs }),
      ...(options.realtimeHeartbeatMs === undefined ? {} : { heartbeatMs: options.realtimeHeartbeatMs })
    },
    realtimeNotifications,
    reconcileUploads: async () => {
      await storage.ensureReady();
      const result = await uploadPipeline.reconcile();
      const deletions = await fileRepository.reconcileDeletionTombstones(storage);
      // A missing committed object or an undecidable tombstone must never make
      // the file API look healthy. main keeps the process fail-closed until an
      // operator has restored/removed the private object and reconciled again.
      if (result.metadataMissing > 0 || result.cleanupFailed > 0 || deletions.failed > 0) throw new Error('UPLOAD_STORAGE_INTEGRITY_FAILED');
      uploadsReady = true;
      return result;
    },
    apiHandler: async (request, response) => {
      const pathname = new URL(request.url ?? '/', 'http://lan-classroom.local').pathname;
      if (pathname.startsWith('/api/auth/')) { await authHandler(request, response); return true; }
      if (pathname.startsWith('/api/teacher/') || pathname === '/api/student/activities') {
        try {
          const handled = activityHandler(request, response);
          if (!handled) sendJson(response, 404, { error: 'NOT_FOUND' });
        } catch (error) { sendError(response, error); }
        return true;
      }
      if (pathname === '/api/classes' || pathname.startsWith('/api/classes/') || pathname.startsWith('/api/pending-student-requests/')) {
        // Public class listing is read-only. All public join requests and every
        // mutation require the configured first-party Origin before parsing a body.
        if (request.method !== 'GET') {
          try { requireAllowedOrigin(request, options.allowedOrigin); } catch (error) { sendError(response, error); return true; }
        }
        try {
          if (pathname.includes('/file-tasks/') && !uploadsReady) { sendJson(response, 503, { error: 'UPLOADS_INITIALIZING' }); return true; }
          const handled = await classHandler(request, response) || await questionBankHandler(request, response) || await fileTaskHandler(request, response) || await uploadHandler(request, response);
          if (!handled) sendJson(response, 404, { error: 'NOT_FOUND' });
        } catch (error) { sendError(response, error); }
        return true;
      }
      if (pathname.startsWith('/api/question-templates') || pathname.startsWith('/api/questions/')) {
        // Route handlers validate the cookie/CSRF context immediately before a
        // service call. Origin is checked here before an untrusted mutation body
        // is parsed, consistently with the existing public class boundary.
        if (request.method !== 'GET') {
          try { requireAllowedOrigin(request, options.allowedOrigin); } catch (error) { sendError(response, error); return true; }
        }
        try {
          const handled = pathname.startsWith('/api/question-templates')
            ? await questionBankHandler(request, response)
            : await liveQuestionHandler(request, response);
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

function assertStudentContext(context: unknown): AuthorizedStudentContext {
  if (typeof context !== 'object' || context === null || (context as Partial<AuthorizedStudentContext>).csrfValidated !== true) {
    throw new HttpError(401, 'STUDENT_AUTH_REQUIRED');
  }
  return context as AuthorizedStudentContext;
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
  // Cursor and limit syntax must not disclose which route or backing fields
  // rejected an opaque token.
  if (code === 'REQUEST_CURSOR_INVALID') { sendJson(response, 400, { error: 'INVALID_REQUEST' }); return; }
  if (code === 'CLASS_NOT_FOUND' || code === 'PENDING_REQUEST_NOT_FOUND_OR_RESOLVED' || code.endsWith('_NOT_FOUND') || code === 'ANSWER_NOT_FOUND') { sendJson(response, 404, { error: code }); return; }
  if (code === 'REQUEST_BODY_TOO_LARGE' || code === 'UPLOAD_TOO_LARGE') { sendJson(response, 413, { error: code }); return; }
  if (code === 'QUESTION_CLASS_FORBIDDEN') { sendJson(response, 403, { error: code }); return; }
  if (code === 'PENDING_APPROVAL_STUDENT_NUMBER_CONFLICT' || code === 'ROSTER_IMPORT_STUDENT_NUMBER_CONFLICT' || code === 'STALE_ANSWER_REVISION' || code === 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST' || code === 'QUESTION_TRANSITION_CONFLICT' || code === 'FILE_SUBMISSION_ALREADY_EXISTS' || code === 'FILE_TASK_TRANSITION_CONFLICT') { sendJson(response, 409, { error: code }); return; }
  if (code === 'UPLOAD_STREAM_LIMIT_REACHED') { sendJson(response, 429, { error: 'UPLOAD_REJECTED' }); return; }
  if (code === 'CLASS_DELETE_CONFIRMATION_REQUIRED' || code === 'DELETE_CONFIRMATION_REQUIRED' || code.startsWith('REQUEST_') || code.startsWith('QUESTION_') || code.startsWith('ANSWER_') || code.startsWith('FILE_') || code.startsWith('UPLOAD_') || code === 'JOIN_IDENTITY_REQUIRED' || code === 'IDEMPOTENCY_KEY_INVALID') { sendJson(response, 400, { error: code.startsWith('UPLOAD_') ? 'UPLOAD_REJECTED' : code }); return; }
  sendJson(response, 500, { error: 'CLASS_INTERNAL_ERROR' });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}
